import type { EditorView } from '@codemirror/view';
import {
	type App,
	type Editor,
	MarkdownView,
	type Menu,
	Modal,
	Notice,
	type Plugin,
	requestUrl,
} from 'obsidian';
import type State from '../State';
import type AiEngine from './AiEngine';
import type { HttpTransport, Status } from './AiEngine';
import { goalHeading, renderDiff, toneSummary } from './aiUi';
import type { RewriteGoal, ToneReport } from './prompts';
import { TONES, type Tone, toneLabel } from './settings';
import { lineAround } from './text';

/** HTTP through Obsidian's `requestUrl`, which is not subject to browser CORS rules. */
export const obsidianTransport: HttpTransport = async ({ url, method, body }) => {
	const res = await requestUrl({
		url,
		method,
		body,
		contentType: body ? 'application/json' : undefined,
		throw: false,
	});
	let json: any = null;
	try {
		json = res.json;
	} catch {
		json = null;
	}
	return { status: res.status, json };
};

type Selection = { from: number; to: number; text: string; context: string };

/** The selection, or the current line when nothing is selected. */
function selectionOrLine(editor: Editor): Selection | null {
	const doc = editor.getValue();
	const fromPos = editor.getCursor('from');
	const toPos = editor.getCursor('to');
	let from = editor.posToOffset(fromPos);
	let to = editor.posToOffset(toPos);
	if (from === to) {
		const line = lineAround(doc, from);
		from = line.from;
		to = line.to;
	}
	const text = doc.slice(from, to);
	if (text.trim().length < 3) return null;
	const line = lineAround(doc, from);
	return { from, to, text, context: doc.slice(line.from, Math.max(line.to, to)) };
}

/** A modal that shows AI rewrites of a selection and replaces it with the one the user clicks. */
export class RewriteModal extends Modal {
	private engine: AiEngine;
	private editor: Editor;
	private sel: Selection;
	private goal: RewriteGoal;
	private off: (() => void) | null = null;

	constructor(app: App, engine: AiEngine, editor: Editor, sel: Selection, goal: RewriteGoal) {
		super(app);
		this.engine = engine;
		this.editor = editor;
		this.sel = sel;
		this.goal = goal;
	}

	onOpen() {
		this.render();
	}

	onClose() {
		this.off?.();
		this.contentEl.empty();
	}

	private render() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('harper-plus-modal');
		this.setTitle(goalHeading(this.goal));

		const tones = contentEl.createDiv({ cls: 'harper-plus-modal-tones' });
		for (const tone of TONES) {
			const chip = tones.createEl('button', { text: toneLabel(tone) });
			if (this.goal.kind === 'tone' && this.goal.tone === tone) chip.addClass('mod-cta');
			chip.onclick = () => {
				this.goal = { kind: 'tone', tone };
				this.render();
			};
		}

		const original = contentEl.createDiv({ cls: 'harper-plus-modal-original' });
		original.createEl('div', { text: 'Original', cls: 'setting-item-name' });
		original.createEl('div', { text: this.sel.text, cls: 'setting-item-description' });

		const list = contentEl.createDiv({ cls: 'harper-plus-modal-list' });
		const { key, status } = this.engine.requestRewrites(this.sel.text, this.sel.context, this.goal, 'hover');
		const draw = (s: Status<string[]>) => {
			list.empty();
			if (s.state === 'pending') {
				list.createEl('p', { text: 'Generating rewrites...', cls: 'setting-item-description' });
			} else if (s.state === 'error') {
				list.createEl('p', { text: s.message, cls: 'mod-warning' });
			} else {
				for (const rewrite of s.value) {
					const b = list.createEl('button', { cls: 'harper-plus-ai-rewrite harper-plus-modal-option' });
					b.append(renderDiff(this.sel.text, rewrite));
					b.onclick = () => this.apply(rewrite);
				}
			}
		};
		draw(status);
		this.off?.();
		if (status.state === 'pending') {
			this.off = this.engine.subscribe(key, () => {
				const next = this.engine.peek<string[]>(key);
				if (next) draw(next);
			});
		}
	}

	private apply(rewrite: string) {
		const doc = this.editor.getValue();
		if (doc.slice(this.sel.from, this.sel.to) !== this.sel.text) {
			new Notice('The text changed since the rewrite was requested.');
			return;
		}
		this.editor.replaceRange(
			rewrite,
			this.editor.offsetToPos(this.sel.from),
			this.editor.offsetToPos(this.sel.to),
		);
		this.close();
	}
}

const MODAL_CSS = `
.cm-tooltip:has(.hp-card) { background: transparent !important; border: none !important; box-shadow: none !important; padding: 0 !important; }
.cm-tooltip:has(.hp-card) > .cm-tooltip-lint { padding: 0 !important; margin: 0 !important; background: transparent !important; }
.harper-plus-modal-tones { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 12px; }
.harper-plus-modal-original { margin-bottom: 12px; }
.harper-plus-modal-list { display: flex; flex-direction: column; gap: 6px; }
.harper-plus-modal .harper-plus-ai-rewrite { text-align: left; white-space: normal; height: auto; line-height: 1.5; padding: 8px 10px; border-radius: 6px; cursor: pointer; }
.harper-plus-modal .harper-plus-diff-del { color: #d93838; text-decoration: line-through; background: #d9383814; }
.harper-plus-modal .harper-plus-diff-ins { color: #4a6ee0; font-weight: 600; text-decoration: none; background: #4a6ee014; }
`;

/** Wires the Obsidian-only AI pieces: commands, the editor menu, and the tone status bar item. */
export class ObsidianAi {
	private plugin: Plugin;
	private getState: () => State | null;
	private toneEl: HTMLElement | null = null;
	private toneTimer: ReturnType<typeof setTimeout> | null = null;
	private lastTone: ToneReport | null = null;
	private toneOff: (() => void) | null = null;

	constructor(plugin: Plugin, getState: () => State | null) {
		this.plugin = plugin;
		this.getState = getState;
	}

	private get engine(): AiEngine | null {
		return this.getState()?.getAiEngine() ?? null;
	}

	private get settings() {
		return this.getState()?.getAiSettings() ?? null;
	}

	public setup() {
		const p = this.plugin;
		const style = document.createElement('style');
		style.id = 'harper-plus-modal-styles';
		style.textContent = MODAL_CSS;
		document.head.appendChild(style);
		p.register(() => style.remove());
		p.addCommand({
			id: 'harper-plus-rewrite-selection',
			name: 'Rewrite selection or line with AI',
			editorCheckCallback: (checking, editor) => {
				if (!this.ready()) return false;
				if (!checking) this.openRewrite(editor, { kind: 'fix', problem: 'Improve clarity and flow.' });
				return true;
			},
		});
		for (const tone of TONES) {
			p.addCommand({
				id: `harper-plus-tone-${tone}`,
				name: `Rewrite selection or line: more ${tone}`,
				editorCheckCallback: (checking, editor) => {
					if (!this.ready() || !this.settings?.toneRewrites) return false;
					if (!checking) this.openRewrite(editor, { kind: 'tone', tone });
					return true;
				},
			});
		}
		p.addCommand({
			id: 'harper-plus-detect-tone',
			name: 'Detect tone of the current note',
			editorCheckCallback: (checking, editor) => {
				if (!this.ready()) return false;
				if (!checking) this.detectTone(editor.getValue(), true);
				return true;
			},
		});

		p.registerEvent(
			p.app.workspace.on('editor-menu', (menu: Menu, editor: Editor) => {
				if (!this.ready()) return;
				menu.addItem((item) => {
					item.setTitle('Rewrite with AI').setIcon('sparkles').setSection('harper-plus');
					item.onClick(() => this.openRewrite(editor, { kind: 'fix', problem: 'Improve clarity and flow.' }));
				});
				if (this.settings?.toneRewrites) {
					for (const tone of ['formal', 'casual', 'confident', 'friendly'] as Tone[]) {
						menu.addItem((item) => {
							item.setTitle(`Make it more ${tone}`).setIcon('wand').setSection('harper-plus');
							item.onClick(() => this.openRewrite(editor, { kind: 'tone', tone }));
						});
					}
				}
			}),
		);

		this.toneEl = p.addStatusBarItem();
		this.toneEl.addClass('mod-clickable');
		this.toneEl.style.display = 'none';
		this.toneEl.onclick = () => this.showToneDetails();

		p.registerEvent(p.app.workspace.on('editor-change', (editor: Editor) => this.scheduleTone(editor)));
		p.registerEvent(
			p.app.workspace.on('active-leaf-change', () => {
				const view = p.app.workspace.getActiveViewOfType(MarkdownView);
				if (view) this.scheduleTone(view.editor, 500);
				else this.renderTone(null);
			}),
		);
	}

	private ready(): boolean {
		return this.engine != null && (this.settings?.enabled ?? false);
	}

	private openRewrite(editor: Editor, goal: RewriteGoal) {
		const engine = this.engine;
		if (engine == null) return;
		const sel = selectionOrLine(editor);
		if (sel == null) {
			new Notice('Select some text (or put the cursor on a line) to rewrite.');
			return;
		}
		new RewriteModal(this.plugin.app, engine, editor, sel, goal).open();
	}

	private scheduleTone(editor: Editor, delay = 4000) {
		if (this.toneTimer) clearTimeout(this.toneTimer);
		if (!this.ready() || !this.settings?.toneDetection) {
			this.renderTone(null);
			return;
		}
		this.toneTimer = setTimeout(() => this.detectTone(editor.getValue(), false), delay);
	}

	private detectTone(text: string, announce: boolean) {
		const engine = this.engine;
		if (engine == null) return;
		const body = text.replace(/^---\n[\s\S]*?\n---\n/, '').trim();
		if (body.split(/\s+/).length < 12) {
			if (announce) new Notice('Write a bit more before detecting tone.');
			this.renderTone(null);
			return;
		}
		const { key, status } = engine.requestTone(body, announce ? 'hover' : 'tone');
		const handle = (s: Status<ToneReport>) => {
			if (s.state === 'ready') {
				this.lastTone = s.value;
				this.renderTone(s.value);
				if (announce) this.showToneDetails();
			} else if (s.state === 'error') {
				if (announce) new Notice(`Tone detection failed: ${s.message}`);
			} else if (this.toneEl) {
				this.toneEl.style.display = '';
				this.toneEl.setText('Tone: ...');
			}
		};
		handle(status);
		this.toneOff?.();
		if (status.state === 'pending') {
			this.toneOff = engine.subscribe(key, () => {
				const next = engine.peek<ToneReport>(key);
				if (next) handle(next);
			});
		}
	}

	private renderTone(report: ToneReport | null) {
		if (!this.toneEl) return;
		if (report == null || !this.settings?.toneDetection || !this.ready()) {
			this.toneEl.style.display = 'none';
			return;
		}
		this.toneEl.style.display = '';
		this.toneEl.setText(`Tone: ${toneSummary(report.tones, report.formality)}`);
		this.toneEl.setAttr('aria-label', report.summary);
	}

	private showToneDetails() {
		const t = this.lastTone;
		if (t == null) return;
		new Notice(
			`Tone: ${t.tones.join(', ') || 'unclear'}\nFormality: ${t.formality}\nConfidence: ${t.confidence}\n${t.summary}\n\nTo change it, select text and use "Rewrite with AI" from the right-click menu.`,
			12000,
		);
	}
}

export function activeEditorView(app: App): EditorView | null {
	const view = app.workspace.getActiveViewOfType(MarkdownView);
	return view ? ((view.editor as any).cm as EditorView) : null;
}
