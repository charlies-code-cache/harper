import type { EditorView } from '@codemirror/view';
import type AiEngine from './AiEngine';
import type { Status } from './AiEngine';
import type { RewriteGoal } from './prompts';
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

/**
 * Builds the "AI rewrites" block shown under Harper's suggestions.
 * It requests rewrites immediately (hover timing) or picks up prefetched ones, then fills in when ready.
 */
export function renderRewriteSection(opts: RewriteSectionOptions): HTMLElement | null {
	const initial = opts.resolve();
	if (initial == null || initial.text.trim().length < 3) return null;

	const root = el('div', 'harper-plus-ai');
	const header = el('div', 'harper-plus-ai-header');
	const title = el('span', 'harper-plus-ai-title', 'AI rewrites');
	const badge = el('span', 'harper-plus-ai-badge', opts.settings.model);
	header.append(title, badge);
	const list = el('div', 'harper-plus-ai-list');
	root.append(header, list);

	let goal = opts.goal;
	let unsubscribe: (() => void) | null = null;
	let activeChip: HTMLElement | null = null;

	const render = (status: Status<string[]>) => {
		list.replaceChildren();
		if (status.state === 'pending') {
			list.append(el('div', 'harper-plus-ai-loading', 'Generating rewrites...'));
		} else if (status.state === 'error') {
			list.append(el('div', 'harper-plus-ai-error', status.message));
		} else {
			for (const rewrite of status.value) {
				const button = el('button', 'harper-plus-ai-rewrite', rewrite);
				button.type = 'button';
				button.title = 'Click to use this rewrite';
				guard(button, () => {
					const target = opts.resolve();
					if (target == null || !opts.apply(target, rewrite)) {
						list.replaceChildren(
							el('div', 'harper-plus-ai-error', 'The text changed. Hover the underline again.'),
						);
					}
				});
				list.append(button);
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
				if (!root.isConnected) {
					unsubscribe?.();
					return;
				}
				const next = opts.engine.peek<string[]>(key);
				if (next) render(next);
			});
		}
	};

	if (opts.showTones) {
		const tones = el('div', 'harper-plus-ai-tones');
		tones.append(el('span', 'harper-plus-ai-tones-label', 'Tone:'));
		for (const tone of TONES.slice(0, 5)) {
			const chip = el('button', 'harper-plus-ai-chip', toneLabel(tone));
			chip.type = 'button';
			chip.title = `Rewrite to sound more ${tone}`;
			guard(chip, () => {
				if (activeChip === chip) {
					chip.classList.remove('is-active');
					activeChip = null;
					goal = opts.goal;
					title.textContent = 'AI rewrites';
				} else {
					activeChip?.classList.remove('is-active');
					chip.classList.add('is-active');
					activeChip = chip;
					goal = { kind: 'tone', tone };
					title.textContent = `More ${tone}`;
				}
				load();
			});
			tones.append(chip);
		}
		root.append(tones);
	}

	// Defer the request until the node is attached, so a quickly dismissed hover still caches the result
	// but listeners only update live DOM.
	queueMicrotask(load);
	return root;
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
