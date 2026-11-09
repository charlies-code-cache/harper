import type { EditorView } from '@codemirror/view';
import type AiEngine from './AiEngine';
import type { Status } from './AiEngine';
import { changeRatio, wordDiff } from './diff';
import { findingLabel, type RewriteGoal } from './prompts';
import { type AiSettings, TONES, type Tone, toneLabel } from './settings';
import type { Range } from './text';

/** What an AI rewrite section replaces, resolved against the current document. */
export type RewriteTarget = Range & {
	/** The exact text being rewritten. */
	text: string;
	/** Nearby text given to the model as context. */
	context: string;
};

export type RewriteSectionOptions = {
	engine: AiEngine;
	settings: AiSettings;
	/** Resolves the target against the editor's current document, or null if it is gone. */
	resolve: () => RewriteTarget | null;
	goal: RewriteGoal;
	/** Whether to show tone chips under the rewrites. */
	showTones: boolean;
	/** Replaces `[from, to)` with `text`. Returns false if the target no longer matches. */
	apply: (target: RewriteTarget, text: string) => boolean;
	/** Called after content changes size, so a tooltip can reposition. */
	onResize?: () => void;
};

function el<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	cls: string,
	text?: string,
): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	node.className = cls;
	if (text != null) node.textContent = text;
	return node;
}

/** Keeps a click inside a CodeMirror tooltip from moving the editor selection or closing the tooltip. */
function guard(node: HTMLElement, onClick: () => void) {
	node.addEventListener('mousedown', (e) => {
		e.preventDefault();
		e.stopPropagation();
	});
	node.addEventListener('click', (e) => {
		e.preventDefault();
		e.stopPropagation();
		onClick();
	});
}

/** Grammarly-style header for a rewrite goal. */
export function goalHeading(goal: RewriteGoal): string {
	switch (goal.kind) {
		case 'fix':
			return 'Improve your text';
		case 'tone':
			return `Make it more ${goal.tone}`;
		case 'finding':
			return `Improve ${findingLabel(goal.findingType).toLowerCase()}`;
	}
}

/**
 * Renders a rewrite as one sentence with removed words struck through in red and new words in blue,
 * like Grammarly. Mostly rewritten text is shown plainly so it stays readable.
 */
export function renderDiff(before: string, after: string): HTMLElement {
	const out = el('span', 'harper-plus-diff');
	const parts = wordDiff(before, after);
	if (changeRatio(parts, before) > 0.6) {
		out.append(el('span', 'harper-plus-diff-new', after));
		return out;
	}
	for (const part of parts) {
		if (part.kind === 'same') out.append(document.createTextNode(part.text));
		else if (part.kind === 'del') out.append(el('del', 'harper-plus-diff-del', part.text));
		else {
			out.append(document.createTextNode(' '));
			out.append(el('ins', 'harper-plus-diff-ins', part.text));
		}
	}
	return out;
}

/**
 * Builds the AI part of a suggestion card: the best rewrite, shown large, plus a "more" block with
 * the other rewrites and tone options. It requests rewrites (hover timing) or picks up prefetched
 * ones, then fills in when ready.
 */
export function renderRewriteSection(
	opts: RewriteSectionOptions,
): { primary: HTMLElement; more: HTMLElement } | null {
	const initial = opts.resolve();
	if (initial == null || initial.text.trim().length < 3) return null;

	const primary = el('div', 'harper-plus-ai');
	const more = el('div', 'harper-plus-ai-alt');
	const altLabel = el('div', 'harper-plus-ai-label');
	const altList = el('div', 'harper-plus-ai-alt');
	more.append(altLabel, altList);

	let goal = opts.goal;
	let unsubscribe: (() => void) | null = null;
	let activeChip: HTMLElement | null = null;

	const rewriteButton = (original: string, rewrite: string) => {
		const button = el('button', 'harper-plus-ai-rewrite');
		button.append(renderDiff(original, rewrite));
		button.type = 'button';
		button.title = 'Click to use this rewrite';
		guard(button, () => {
			const target = opts.resolve();
			if (target == null || !opts.apply(target, rewrite)) {
				primary.replaceChildren(
					el('div', 'harper-plus-ai-loading', 'The text changed. Hover the underline again.'),
				);
			}
		});
		return button;
	};

	const render = (status: Status<string[]>) => {
		primary.replaceChildren();
		altList.replaceChildren();
		altLabel.textContent = '';
		if (status.state === 'pending') {
			primary.append(el('div', 'harper-plus-ai-loading', 'Writing a suggestion...'));
		} else if (status.state === 'error') {
			primary.append(el('div', 'harper-plus-ai-error', status.message));
		} else {
			const original = opts.resolve()?.text ?? initial.text;
			const [best, ...rest] = status.value;
			if (activeChip) primary.append(el('div', 'harper-plus-ai-label', goalHeading(goal)));
			primary.append(rewriteButton(original, best));
			if (rest.length > 0) {
				altLabel.textContent = 'Other rewrites';
				for (const r of rest) altList.append(rewriteButton(original, r));
			}
		}
		opts.onResize?.();
	};

	const load = () => {
		unsubscribe?.();
		const target = opts.resolve();
		if (target == null) return;
		const { key, status } = opts.engine.requestRewrites(target.text, target.context, goal, 'hover');
		render(status);
		if (status.state === 'pending') {
			unsubscribe = opts.engine.subscribe(key, () => {
				if (!primary.isConnected) {
					unsubscribe?.();
					return;
				}
				const next = opts.engine.peek<string[]>(key);
				if (next) render(next);
			});
		}
	};

	if (opts.showTones) {
		more.append(el('div', 'harper-plus-ai-label', 'Change the tone'));
		const tones = el('div', 'harper-plus-ai-tones');
		for (const tone of TONES.slice(0, 5)) {
			const chip = el('button', 'harper-plus-ai-chip', toneLabel(tone));
			chip.type = 'button';
			chip.title = `Rewrite to sound more ${tone}`;
			guard(chip, () => {
				activeChip?.classList.remove('is-active');
				if (activeChip === chip) {
					activeChip = null;
					goal = opts.goal;
				} else {
					chip.classList.add('is-active');
					activeChip = chip;
					goal = { kind: 'tone', tone };
				}
				load();
			});
			tones.append(chip);
		}
		more.append(tones);
	}

	queueMicrotask(load);
	return { primary, more };
}

/** Applies a rewrite to a CodeMirror view after confirming the target text is unchanged. */
export function applyToView(view: EditorView, target: RewriteTarget, text: string): boolean {
	const current = view.state.doc.sliceString(target.from, target.to);
	if (current !== target.text) return false;
	view.dispatch({
		changes: { from: target.from, to: target.to, insert: text },
		selection: { anchor: target.from + text.length },
		scrollIntoView: true,
	});
	view.focus();
	return true;
}

/** Short human summary of a tone report, for the status bar. */
export function toneSummary(tones: string[], formality: string): string {
	const label = tones
		.slice(0, 2)
		.map((t) => t.charAt(0).toUpperCase() + t.slice(1).toLowerCase())
		.join(', ');
	return label.length > 0 ? label : formality;
}

export function isTone(value: string): value is Tone {
	return (TONES as readonly string[]).includes(value);
}
