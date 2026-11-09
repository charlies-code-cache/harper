import type { Extension, StateField } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import type { Lint, LintConfig, Linter, StructuredLintConfig, Suggestion } from 'harper.js';
import { type Dialect, LocalLinter, SuggestionKind, WorkerLinter } from 'harper.js';
import { slimBinaryInlined } from 'harper.js/slimBinaryInlined';
import { minimatch } from 'minimatch';
import type { MarkdownFileInfo } from 'obsidian';
import AiEngine, { type Finding, type HttpTransport } from './ai/AiEngine';
import {
	applyToView,
	goalHeading,
	type RewriteSectionOptions,
	type RewriteTarget,
	renderRewriteSection,
	rewriteClusters,
} from './ai/aiUi';
import { showActiveHighlight } from './lint';
import { findingLabel, type FindingType, type RewriteGoal } from './ai/prompts';
import { type AiSettings, withAiDefaults } from './ai/settings';
import { lineAround, sentenceAround } from './ai/text';
import { type Action, aiRefreshEffect, type Diagnostic, linter } from './lint';
import { lintKindClass } from './lintKindColor';

export type Settings = {
	ignoredLints?: string;
	useWebWorker: boolean;
	dialect?: Dialect;
	lintSettings: LintConfig;
	userDictionary?: string[];
	delay?: number;
	ignoredGlobs?: string[];
	lintEnabled?: boolean;
	regexMask?: string;
	useWebStyleLints?: boolean;
	/** Harper Plus AI settings. */
	ai?: AiSettings;
};

/** Lint kinds whose problems are about a whole sentence, which get AI rewrites in the "sentence" scope. */
const SENTENCE_LEVEL_KINDS = new Set([
	'Readability',
	'Style',
	'Redundancy',
	'Repetition',
	'WordChoice',
	'Enhancement',
	'WordOrder',
	'Usage',
	'Nonstandard',
]);

const SPELLING_KINDS = new Set(['Spelling', 'Typo', 'Eggcorn', 'Malapropism']);

/** Maps AI finding types onto Harper lint kinds so they share Harper's colors. */
const FINDING_KIND: Record<FindingType, string> = {
	clarity: 'Readability',
	conciseness: 'Redundancy',
	word_choice: 'WordChoice',
	fluency: 'Style',
};

/** The rule name AI lints are reported under. */
export const AI_SOURCE = 'HarperPlusAI';

const DEFAULT_DELAY = -1;

/** The centralized state for the entire Obsidian plugin.
 * Since it also contains most business logic, for testing purpose it should not interact with Obsidian directly.*/
export default class State {
	private harper: Linter;
	private saveData: (data: any) => Promise<void>;
	private delay: number;
	private onExtensionChange: () => void;
	private ignoredGlobs?: string[];
	private editorInfoField?: StateField<MarkdownFileInfo>;
	private lintEnabled?: boolean;
	private regexMask?: string;
	private useWebStyleLints = false;
	private aiSettings: AiSettings = withAiDefaults(null);
	private ai: AiEngine | null = null;

	/** The CodeMirror extension objects that should be inserted by the host. */
	private editorExtensions: Extension[];

	/** @param saveDataCallback A callback which will be used to save data on disk.
	 * @param onExtensionChange A callback this class will run when the extension array is modified.
	 * @param editorViewField Needed to provide support for ignoring files based on path.*/
	constructor(
		saveDataCallback: (data: any) => Promise<void>,
		onExtensionChange: () => void,
		_editorInfoField?: StateField<MarkdownFileInfo>,
		http?: HttpTransport,
	) {
		this.harper = new WorkerLinter({ binary: slimBinaryInlined });
		this.delay = DEFAULT_DELAY;
		this.saveData = saveDataCallback;
		this.onExtensionChange = onExtensionChange;
		this.editorExtensions = [];

		this.editorInfoField = _editorInfoField;
		if (http) {
			this.ai = new AiEngine(http, () => this.aiSettings);
		}
	}

	/** The AI engine, if AI features are available in this host. */
	public getAiEngine(): AiEngine | null {
		return this.ai;
	}

	public getAiSettings(): AiSettings {
		return this.aiSettings;
	}

	/** Updates AI settings, persists them, and re-lints. */
	public async setAiSettings(patch: Partial<AiSettings>) {
		const settings = await this.getSettings();
		settings.ai = withAiDefaults({ ...this.aiSettings, ...patch });
		await this.initializeFromSettings(settings);
	}

	public async initializeFromSettings(settings: Settings | null) {
		if (settings == null) {
			settings = {
				useWebWorker: true,
				lintEnabled: true,
				lintSettings: {},
			};
		}

		const defaultConfig = await this.harper.getDefaultLintConfig();
		for (const key of Object.keys(defaultConfig)) {
			if (settings.lintSettings[key] == undefined) {
				settings.lintSettings[key] = null;
			}
		}

		const oldSettings = await this.getSettings();

		if (
			settings.useWebWorker !== oldSettings.useWebWorker ||
			settings.dialect !== oldSettings.dialect
		) {
			if (settings.useWebWorker) {
				this.harper.dispose();
				this.harper = new WorkerLinter({ binary: slimBinaryInlined, dialect: settings.dialect });
			} else {
				this.harper.dispose();
				this.harper = new LocalLinter({ binary: slimBinaryInlined, dialect: settings.dialect });
			}
		} else {
			await this.harper.clearIgnoredLints();
		}

		if (settings.ignoredLints !== undefined) {
			await this.harper.importIgnoredLints(settings.ignoredLints);
		}

		if (settings.userDictionary != null) {
			await this.harper.clearWords();
			if (settings.userDictionary.length > 0) {
				await this.harper.importWords(settings.userDictionary);
			}
		}

		await this.harper.setLintConfig(settings.lintSettings);
		this.harper.setup();

		this.delay = settings.delay ?? DEFAULT_DELAY;
		this.ignoredGlobs = settings.ignoredGlobs;
		this.lintEnabled = settings.lintEnabled;
		this.regexMask = settings.regexMask;
		this.useWebStyleLints = settings.useWebStyleLints ?? false;
		const nextAi = withAiDefaults(settings.ai);
		if (
			nextAi.model !== this.aiSettings.model ||
			nextAi.ollamaUrl !== this.aiSettings.ollamaUrl ||
			nextAi.rewriteCount !== this.aiSettings.rewriteCount ||
			nextAi.styleNote !== this.aiSettings.styleNote ||
			nextAi.temperature !== this.aiSettings.temperature
		) {
			this.ai?.clearCache();
		}
		this.aiSettings = nextAi;
		settings.ai = nextAi;

		// Reinitialize it.
		if (this.hasEditorLinter()) {
			this.disableEditorLinter(false);
			this.enableEditorLinter(false);
		}

		await this.saveData(settings);
	}

	/** Construct the linter plugin that actually shows the errors. */
	private constructEditorLinter(): Extension {
		return linter(
			async (view) => {
				const ignoredGlobs = this.ignoredGlobs ?? [];

				if (this.editorInfoField != null) {
					const mdView = view.state.field(this.editorInfoField, false);
					const file = mdView?.file;

					if (file != null) {
						const path = file.path;
						for (const glob of ignoredGlobs) {
							if (minimatch(path, glob)) {
								return [];
							}
						}
					}
				}

				const text = view.state.doc.sliceString(-1);
				const lints = await this.harper.organizedLints(text, { regex_mask: this.regexMask });

				const harperDiagnostics = Object.entries(lints).flatMap(([linterName, lints]) =>
					lints.map((lint) => {
						const span = lint.span();

						const problem = lint.get_problem_text();
						const actions: Action[] = lint.suggestions().map((sug): Action => {
							return {
								preview: {
									before: problem,
									after:
										sug.kind() === SuggestionKind.Remove
											? ''
											: sug.kind() === SuggestionKind.Replace
												? sug.get_replacement_text()
												: problem + sug.get_replacement_text(),
								},
								kind: 'suggestion' as const,
								name:
									sug.kind() == SuggestionKind.Replace
										? sug.get_replacement_text()
										: suggestionToLabel(sug),
								title: suggestionToLabel(sug),
								apply: (view, from, to) => {
									if (sug.kind() === SuggestionKind.Remove) {
										view.dispatch({
											changes: {
												from,
												to,
												insert: '',
											},
											selection: {
												anchor: from,
											},
										});
									} else if (sug.kind() === SuggestionKind.Replace) {
										const replacement = sug.get_replacement_text();
										view.dispatch({
											changes: {
												from,
												to,
												insert: replacement,
											},
											selection: {
												anchor: from + replacement.length,
											},
										});
									} else if (sug.kind() === SuggestionKind.InsertAfter) {
										const replacement = sug.get_replacement_text();
										view.dispatch({
											changes: {
												from: to,
												to,
												insert: replacement,
											},
											selection: {
												anchor: to + replacement.length,
											},
										});
									}
								},
							};
						});

						if (lint.lint_kind() === 'Spelling') {
							const word = lint.get_problem_text();

							actions.push({
								kind: 'dictionary',
								name: '📖',
								title: `Add “${word}” to your dictionary`,
								apply: (view, _from, to) => {
									view.dispatch({
										selection: {
											anchor: to,
										},
									});
									this.harper.importWords([word]);
									this.reinitialize();
								},
							});
						}

						return {
							from: span.start,
							to: span.end,
							source: linterName,
							severity: 'error',
							markClass: `${lintKindClass(lint.lint_kind())} ${this.useWebStyleLints ? 'harper-web-style' : 'harper-squiggly-style'}`,
							title: lint.lint_kind_pretty(),
							message: lint.message(),
							renderMessage: (_view) => {
								const node = document.createElement('template');
								node.innerHTML = lint.message_html();
								return node.content;
							},
							ignore: async () => {
								await this.ignoreLints(text, [lint]);
							},
							renderExtra: this.rewriteRendererForLint(
								lint.lint_kind(),
								lint.message(),
								span.start,
								span.end,
								text,
								lint.suggestions().length > 0,
							),
							disable: async () => {
								const lintConfig = await this.harper.getLintConfig();
								lintConfig[linterName] = false;
								await this.harper.setLintConfig(lintConfig);

								await this.reinitialize();
							},

							actions,
						} as Diagnostic;
					}),
				);

				return this.splitForDisplay(
					view,
					text,
					harperDiagnostics.concat(this.aiDiagnostics(view, text)),
				);
			},
			{
				delay: this.delay,
			},
		);
	}

	private aiReady(): boolean {
		return this.ai != null && this.aiSettings.enabled;
	}

	/** Decides whether a Harper lint gets AI rewrites and, in prefetch mode, starts generating them. */
	private rewriteRendererForLint(
		kind: string,
		message: string,
		from: number,
		to: number,
		text: string,
		hasHarperFix: boolean,
	): Diagnostic['renderExtra'] {
		const ai = this.ai;
		const s = this.aiSettings;
		if (ai == null || !s.enabled || !s.rewrites || SPELLING_KINDS.has(kind)) return undefined;
		if (s.rewriteScope === 'sentence' && !SENTENCE_LEVEL_KINDS.has(kind)) return undefined;

		const sentence = sentenceAround(text, from, to);
		const target = text.slice(sentence.from, sentence.to);
		const line = lineAround(text, from);
		const context = text.slice(line.from, line.to);
		const goal: RewriteGoal = { kind: 'fix', problem: message };

		if (s.timing === 'prefetch') {
			ai.requestRewrites(target, context, goal, 'prefetch');
		}
		const render = (focus: { from: number; to: number } | null): Diagnostic['renderExtra'] =>
			(view, current) =>
				renderRewriteSection({
					...this.sectionOptions(view, ai, goal),
					primary: !hasHarperFix,
					focus,
					resolve: () => resolveTarget(view, current, target, context),
				});
		this.pendingTargets.set(`${from}:${to}`, {
			from: sentence.from,
			text: target,
			goal,
			render: hasHarperFix ? null : render,
		});
		return render(null);
	}

	/** Options shared by every AI section in a card. */
	private sectionOptions(
		view: EditorView,
		ai: AiEngine,
		goal: RewriteGoal,
	): Omit<RewriteSectionOptions, 'resolve'> {
		return {
			engine: ai,
			settings: this.aiSettings,
			goal,
			showTones: this.aiSettings.toneRewrites,
			apply: (t, rewrite) => applyToView(view, t, rewrite),
			applyRange: (from, to, expected, text) => {
				if (view.state.doc.sliceString(from, to) !== expected) return false;
				view.dispatch({
					changes: { from, to, insert: text },
					selection: { anchor: from + text.length },
				});
				view.focus();
				return true;
			},
			highlight: (dom, sentence, words) => showActiveHighlight(view, dom, { sentence, words }),
			onReady: () => this.refreshView(view),
			onResize: () => view.requestMeasure(),
		};
	}

	/** AI targets of the diagnostics built in the current lint pass, keyed by `from:to`. */
	private pendingTargets = new Map<
		string,
		{
			from: number;
			text: string;
			goal: RewriteGoal;
			/** Builds the card for one edit (focus) or all edits (null); null when Harper has a fix. */
			render: ((focus: { from: number; to: number } | null) => Diagnostic['renderExtra']) | null;
		}
	>();
	private watchedKeys = new Set<string>();

	/**
	 * Grammarly underlines only the words a fix changes, not whole sentences. Long diagnostics are
	 * split into one underline per changed span once a rewrite is known, and shown as a short anchor
	 * on the first words until then. Every piece opens the same suggestion card.
	 */
	private splitForDisplay(view: EditorView, text: string, diagnostics: Diagnostic[]): Diagnostic[] {
		const ai = this.ai;
		const targets = this.pendingTargets;
		this.pendingTargets = new Map();
		const out: Diagnostic[] = [];
		for (const d of diagnostics) {
			const span = text.slice(d.from, d.to);
			const target = targets.get(`${d.from}:${d.to}`);
			const isLong = span.split(/\s+/).filter(Boolean).length > 4;
			if (target?.render == null && !isLong) {
				out.push(d);
				continue;
			}
			const group = `${d.source}:${d.from}:${d.to}:${d.message}`;
			if (ai != null && target != null) {
				const key = ai.rewriteKey(target.text, target.goal);
				const status = ai.peek<string[]>(key);
				const clusters =
					status?.state === 'ready' && target.render
						? rewriteClusters(target.text, status.value[0])
						: null;
				if (clusters && target.render) {
					// One small correction per edit, each with its own underline and card.
					for (const c of clusters) {
						const lead = c.before.length - c.before.trimStart().length;
						const trail = c.before.length - c.before.trimEnd().length;
						const from = target.from + c.from + lead;
						const to = Math.max(from + 1, target.from + c.to - trail);
						out.push({
							...d,
							from,
							to,
							group: `${group}:${c.from}`,
							renderExtra: target.render({ from: c.from, to: c.to }),
						});
					}
					continue;
				}
				if (status?.state === 'pending') this.watchKey(view, key);
			}
			if (!isLong) {
				out.push(d);
				continue;
			}
			const anchor = anchorRange(text, d.from, d.to);
			out.push({ ...d, from: anchor.from, to: anchor.to, group });
		}
		return out;
	}

	/** Re-lints once a pending rewrite lands, so its edits get their own underlines. */
	private watchKey(view: EditorView, key: string) {
		const ai = this.ai;
		if (ai == null || this.watchedKeys.has(key)) return;
		this.watchedKeys.add(key);
		const off = ai.subscribe(key, () => {
			off();
			this.watchedKeys.delete(key);
			this.refreshView(view);
		});
	}


	/** Re-lints a view, waiting while a suggestion card is open because re-linting closes it. */
	private refreshView(view: EditorView) {
		if (view.dom.querySelector('.cm-tooltip-lint') != null) {
			setTimeout(() => this.refreshView(view), 1500);
			return;
		}
		try {
			view.dispatch({ effects: aiRefreshEffect.of(null) });
		} catch {
			// The view was destroyed.
		}
	}

	/** Turns cached AI scan findings into diagnostics and queues scans for settled paragraphs. */
	private aiDiagnostics(view: EditorView, text: string): Diagnostic[] {
		const ai = this.ai;
		if (ai == null || !this.aiReady()) return [];
		const refresh = () => {
			// Re-linting closes open popups, so wait until the user is done with one.
			if (view.dom.querySelector('.cm-tooltip-lint') != null) {
				setTimeout(refresh, 1500);
				return;
			}
			try {
				view.dispatch({ effects: aiRefreshEffect.of(null) });
			} catch {
				// The view was destroyed.
			}
		};
		const findings = ai.scan(text, refresh);
		return findings.map((f) => this.findingToDiagnostic(f, ai));
	}

	private findingToDiagnostic(f: Finding, ai: AiEngine): Diagnostic {
		const goal: RewriteGoal = { kind: 'finding', findingType: f.type, reason: f.reason };
		if (this.aiSettings.timing === 'prefetch') {
			ai.requestRewrites(f.quote, f.paragraph, goal, 'prefetch');
		}
		const render = (focus: { from: number; to: number } | null): Diagnostic['renderExtra'] =>
			(view, current) =>
				renderRewriteSection({
					...this.sectionOptions(view, ai, goal),
					focus,
					resolve: () => resolveTarget(view, current, f.quote, f.paragraph, false),
				});
		this.pendingTargets.set(`${f.from}:${f.to}`, { from: f.from, text: f.quote, goal, render });
		const feature: 'clarity' | 'wordChoice' =
			f.type === 'clarity' || f.type === 'conciseness' ? 'clarity' : 'wordChoice';
		return {
			from: f.from,
			to: f.to,
			source: AI_SOURCE,
			severity: 'info',
			markClass: `${lintKindClass(FINDING_KIND[f.type])} harper-plus-ai-range ${this.useWebStyleLints ? 'harper-web-style' : 'harper-squiggly-style'}`,
			title: goalHeading(goal),
			message: f.reason.length > 0 ? f.reason : `Possible ${findingLabel(f.type).toLowerCase()} issue.`,
			actions: [],
			ignore: async () => {
				await this.setAiSettings({ ignored: [...this.aiSettings.ignored, f.id] });
			},
			disable: async () => {
				await this.setAiSettings({ [feature]: false });
			},
			renderExtra: render(null),
		};
	}

	/** Use this method instead of interacting with the linter directly. */
	public async ignoreLints(text: string, lints: Lint[]) {
		for (const lint of lints) {
			await this.harper.ignoreLint(text, lint);
		}

		await this.reinitialize();
	}

	public async reinitialize() {
		const settings = await this.getSettings();
		await this.initializeFromSettings(settings);
	}

	public async getSettings(): Promise<Settings> {
		const usingWebWorker = this.harper instanceof WorkerLinter;

		const userDictionary = await this.harper.exportWords();
		userDictionary.sort();

		return {
			ignoredLints: await this.harper.exportIgnoredLints(),
			useWebWorker: usingWebWorker,
			lintSettings: await this.harper.getLintConfig(),
			userDictionary,
			dialect: await this.harper.getDialect(),
			delay: this.delay,
			ignoredGlobs: this.ignoredGlobs,
			lintEnabled: this.lintEnabled,
			regexMask: this.regexMask,
			useWebStyleLints: this.useWebStyleLints,
			ai: this.aiSettings,
		};
	}

	/**
	 * Reset all lint rule overrides back to their defaults (null).
	 * Persists and reinitializes state to apply changes.
	 */
	public async resetAllRulesToDefaults(): Promise<void> {
		const settings = await this.getSettings();
		for (const key of Object.keys(settings.lintSettings)) {
			settings.lintSettings[key] = null;
		}
		await this.initializeFromSettings(settings);
	}

	/**
	 * Enable or disable all lint rules in bulk by setting explicit values.
	 * This overrides individual rule settings until changed again.
	 */
	public async setAllRulesEnabled(enabled: boolean): Promise<void> {
		const settings = await this.getSettings();
		for (const key of Object.keys(settings.lintSettings)) {
			settings.lintSettings[key] = enabled;
		}
		await this.initializeFromSettings(settings);
	}

	public async getDescriptionHTML(): Promise<Record<string, string>> {
		return await this.harper.getLintDescriptionsHTML();
	}

	/** Expose the structured lint configuration for UI rendering only.
	 * Rule state must still be persisted through flat `lintSettings`. */
	public async getStructuredLintConfig(): Promise<StructuredLintConfig> {
		return await this.harper.getStructuredLintConfig();
	}

	/** Expose the default lint configuration for UI rendering. */
	public async getDefaultLintConfig(): Promise<LintConfig> {
		return await this.harper.getDefaultLintConfig();
	}

	/** Effective config: merges defaults with overrides (null/undefined uses default). */
	public async getEffectiveLintConfig(): Promise<Record<string, boolean>> {
		const defaults = (await this.getDefaultLintConfig()) as Record<string, boolean>;
		const overrides = (await this.getSettings()).lintSettings as Record<
			string,
			boolean | null | undefined
		>;
		const effective: Record<string, boolean> = {};
		for (const key of Object.keys(defaults)) {
			const v = overrides[key];
			effective[key] = v === null || v === undefined ? defaults[key] : Boolean(v);
		}
		return effective;
	}

	/** Determine if any rules are effectively enabled, considering defaults. */
	public async areAnyRulesEnabled(): Promise<boolean> {
		const settings = await this.getSettings();
		const defaults = await this.getDefaultLintConfig();
		for (const key of Object.keys(settings.lintSettings)) {
			const v = settings.lintSettings[key] as boolean | null | undefined;
			const def = (defaults as Record<string, boolean | undefined>)[key];
			const effective = v === null || v === undefined ? def : v;
			if (effective) return true;
		}
		return false;
	}

	/** Get a reference to the CM editor extensions.
	 * Do not mutate the returned value, except via methods on this class. */
	public getCMEditorExtensions(): Extension[] {
		return this.editorExtensions;
	}

	/** Enables the editor linter by adding an extension to the editor extensions array. */
	public enableEditorLinter(reinit = true) {
		if (!this.hasEditorLinter()) {
			this.editorExtensions.push(this.constructEditorLinter());
			this.lintEnabled = true;
			this.onExtensionChange();
			if (reinit) this.reinitialize();
			console.log('Enabled');
		}
	}

	/** Disables the editor linter by removing the extension from the editor extensions array. */
	public disableEditorLinter(reinit = true) {
		while (this.hasEditorLinter()) {
			this.editorExtensions.pop();
		}
		this.lintEnabled = false;
		this.onExtensionChange();
		if (reinit) this.reinitialize();
		console.log('Disabled');
	}

	public hasEditorLinter(): boolean {
		return this.editorExtensions.length !== 0;
	}

	public toggleAutoLint() {
		if (this.hasEditorLinter()) {
			this.disableEditorLinter();
		} else {
			this.enableEditorLinter();
		}
	}

	/** Get a reference to the current linter.
	 * It's best not to hold on to this type and to instead use this function again if another reference is needed. */
	public getLinter(): Linter {
		return this.harper;
	}
}

function suggestionToLabel(sug: Suggestion): string {
	switch (sug.kind()) {
		case SuggestionKind.Remove:
			return 'Remove';
		case SuggestionKind.Replace:
			return `Replace with “${sug.get_replacement_text()}”`;
		case SuggestionKind.InsertAfter:
			return `Insert “${sug.get_replacement_text()}” after this.`;
	}
}

/** Re-finds a sentence target in the current document, following edits made since it was linted. */
function resolveTarget(
	view: EditorView,
	current: () => { from: number; to: number } | null,
	target: string,
	context: string,
	trySentence = true,
): RewriteTarget | null {
	const range = current();
	if (range == null) return null;
	const doc = view.state.doc.toString();
	const sentence = sentenceAround(doc, range.from, range.to);
	if (trySentence && doc.slice(sentence.from, sentence.to) === target) {
		return { ...sentence, text: target, context };
	}
	const line = lineAround(doc, range.from);
	const idx = doc.slice(line.from, line.to).indexOf(target);
	if (idx < 0) return null;
	return { from: line.from + idx, to: line.from + idx + target.length, text: target, context };
}

/** A short underline on the first few words of a long flag, used until its rewrite is known. */
function anchorRange(text: string, from: number, to: number): { from: number; to: number } {
	const re = /\S+/g;
	re.lastIndex = from;
	let end = from;
	for (let i = 0; i < 3; i++) {
		const m = re.exec(text);
		if (m == null || m.index >= to) break;
		end = Math.min(to, m.index + m[0].length);
	}
	return { from, to: Math.max(end, from + 1) };
}
