import type { EditorView } from '@codemirror/view';
import type AiEngine from './AiEngine';
import type { Status } from './AiEngine';
import { type Cluster, changeClusters, changeRatio, wordDiff } from './diff';
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
	/** Offsets (into the target text) of the one edit this card is about, or null for all edits. */
	focus?: { from: number; to: number } | null;
	/** False when Harper already offers a fix: the AI rewrite then waits behind "See more". */
	primary?: boolean;
	/** Replaces an exact document range, verifying its text first. Used to apply one edit. */
	applyRange?: (from: number, to: number, expected: string, text: string) => boolean;
	/** Called once rewrites are ready, so the editor can re-split underlines after the card closes. */
	onReady?: () => void;
	/** Highlights the sentence and its edited words while the card is open. */
	highlight?: (dom: HTMLElement, sentence: { from: number; to: number }, words: { from: number; to: number }[]) => void;
};

/** How many separate edits a card may list before it falls back to one whole-sentence rewrite. */
const MAX_CLUSTERS = 4;

/** The edits a rewrite makes, or null when it rewrites too much to split into small corrections. */
export function rewriteClusters(original: string, rewrite: string): Cluster[] | null {
	if (changeRatio(wordDiff(original, rewrite), original) > 0.6) return null;
	const clusters = changeClusters(original, rewrite);
	return clusters.length > 0 && clusters.length <= MAX_CLUSTERS ? clusters : null;
}

/** One small correction: a few words of context around a single struck/bold edit. */
function clusterNode(text: string, c: Cluster): HTMLElement {
	// Just the edit, like Grammarly's short corrections: struck old words, bold new ones.
	void text;
	const out = el('span', 'harper-plus-diff');
	for (const part of wordDiff(c.before, c.after)) {
		if (part.kind === 'same') out.append(document.createTextNode(part.text));
		else if (part.kind === 'del') out.append(el('del', 'harper-plus-diff-del', part.text));
		else {
			if (out.lastChild?.nodeName === 'DEL') out.append(document.createTextNode(' '));
			out.append(el('ins', 'harper-plus-diff-ins', part.text));
		}
	}
	return out;
}

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
	const showPrimary = opts.primary ?? true;

	const primary = el('div', 'harper-plus-ai');
	const more = el('div', 'harper-plus-ai-alt');
	const altBox = el('div', 'harper-plus-ai-alt');
	more.append(altBox);

	let goal = opts.goal;
	let unsubscribe: (() => void) | null = null;
	let activeChip: HTMLElement | null = null;

	const failed = () =>
		el('div', 'harper-plus-ai-loading', 'The text changed. Hover the underline again.');

	const wholeButton = (original: string, rewrite: string) => {
		const button = el('button', 'harper-plus-ai-rewrite');
		button.append(renderDiff(original, rewrite));
		button.type = 'button';
		button.title = 'Use this rewrite';
		guard(button, () => {
			const target = opts.resolve();
			if (target == null || !opts.apply(target, rewrite)) primary.replaceChildren(failed());
		});
		return button;
	};

	const clusterButton = (original: string, c: Cluster) => {
		const button = el('button', 'hp-suggestion');
		button.append(clusterNode(original, c));
		button.type = 'button';
		button.title = 'Apply this change';
		guard(button, () => {
			const target = opts.resolve();
			const ok =
				target != null &&
				(opts.applyRange?.(target.from + c.from, target.from + c.to, c.before, c.after) ?? false);
			if (!ok) primary.replaceChildren(failed());
		});
		return button;
	};

	const render = (status: Status<string[]>) => {
		primary.replaceChildren();
		altBox.replaceChildren();
		const into = showPrimary ? primary : altBox;
		if (status.state === 'pending') {
			into.append(el('div', 'harper-plus-ai-loading', 'Writing a suggestion...'));
		} else if (status.state === 'error') {
			into.append(el('div', 'harper-plus-ai-error', status.message));
		} else {
			const target = opts.resolve();
			const original = target?.text ?? initial.text;
			const [best, ...rest] = status.value;
			if (activeChip) into.append(el('div', 'harper-plus-ai-label', goalHeading(goal)));
			const clusters = rewriteClusters(original, best);
			const focused =
				clusters && opts.focus
					? clusters.filter((c) => c.from < opts.focus!.to && c.to > opts.focus!.from)
					: clusters;
			if (focused && focused.length > 0 && showPrimary) {
				for (const c of focused) into.append(clusterButton(original, c));
				altBox.append(el('div', 'harper-plus-ai-label', 'Rewrite the whole sentence'));
				altBox.append(wholeButton(original, best));
			} else {
				if (!showPrimary) into.append(el('div', 'harper-plus-ai-label', 'AI rewrite of the sentence'));
				into.append(wholeButton(original, best));
			}
			if (rest.length > 0) {
				altBox.append(el('div', 'harper-plus-ai-label', 'Other rewrites'));
				for (const r of rest) altBox.append(wholeButton(original, r));
			}
			if (!opts.focus) opts.onReady?.();
			if (target && opts.highlight) {
				const words = (focused ?? []).map((c) => ({ from: target.from + c.from, to: target.from + c.to }));
				opts.highlight(primary, { from: target.from, to: target.to }, words);
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
