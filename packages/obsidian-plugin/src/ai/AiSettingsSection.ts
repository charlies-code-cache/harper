import { Notice, Setting } from 'obsidian';
import type State from '../State';
import type { Settings } from '../State';
import { type AiSettings, withAiDefaults } from './settings';

/** Renders the "Harper Plus AI" block at the top of the settings tab. */
export function renderAiSettings(containerEl: HTMLElement, state: State, settings: Settings) {
	const ai = withAiDefaults(settings.ai);
	const engine = state.getAiEngine();

	const save = async (patch: Partial<AiSettings>) => {
		Object.assign(ai, patch);
		settings.ai = withAiDefaults(ai);
		await state.initializeFromSettings(settings);
	};

	new Setting(containerEl)
		.setName('Harper Plus AI')
		.setHeading()
		.setDesc(
			'Writing help from a local Ollama model: rewrites, clarity, tone, and word choice. Nothing leaves this computer.',
		);

	new Setting(containerEl)
		.setName('Enable AI features')
		.setDesc('Master switch for everything in this section.')
		.addToggle((t) => t.setValue(ai.enabled).onChange((v) => save({ enabled: v })));

	let modelDropdownEl: HTMLSelectElement | null = null;
	const status = containerEl.createDiv({ cls: 'setting-item-description harper-plus-ai-status' });
	status.style.margin = '0 0 8px 0';

	const refreshModels = async (url: string) => {
		if (engine == null || modelDropdownEl == null) return;
		status.setText('Checking Ollama...');
		try {
			const models = await engine.listModels(url);
			const select = modelDropdownEl;
			select.empty();
			const names = models.includes(ai.model) || ai.model === '' ? models : [ai.model, ...models];
			for (const name of names) {
				const opt = select.createEl('option', { text: name, value: name });
				if (name === ai.model) opt.selected = true;
			}
			status.setText(
				models.length > 0
					? `Connected to Ollama. ${models.length} model${models.length === 1 ? '' : 's'} installed.`
					: 'Connected, but no models are installed. Run "ollama pull gemma3:4b".',
			);
		} catch (e) {
			status.setText(`Could not reach Ollama at ${url}: ${e instanceof Error ? e.message : e}`);
		}
	};

	new Setting(containerEl)
		.setName('Ollama URL')
		.setDesc('Where the local Ollama server listens.')
		.addText((text) => {
			text.setPlaceholder('http://localhost:11434').setValue(ai.ollamaUrl);
			text.inputEl.addEventListener('change', async () => {
				await save({ ollamaUrl: text.getValue().trim() || 'http://localhost:11434' });
				await refreshModels(ai.ollamaUrl);
			});
		});

	new Setting(containerEl)
		.setName('Model')
		.setDesc('Installed Ollama models. Smaller models answer faster.')
		.addDropdown((dropdown) => {
			modelDropdownEl = dropdown.selectEl;
			dropdown.addOption(ai.model, ai.model).setValue(ai.model);
			dropdown.onChange((v) => save({ model: v }));
		})
		.addExtraButton((b) =>
			b
				.setIcon('refresh-cw')
				.setTooltip('Refresh model list')
				.onClick(() => refreshModels(ai.ollamaUrl)),
		)
		.addButton((b) =>
			b.setButtonText('Test').onClick(async () => {
				if (engine == null) return;
				const started = Date.now();
				const sample = 'In my opinion I think that the meeting that we had was kind of not very productive.';
				new Notice('Harper Plus: asking the model for a test rewrite...');
				const { key, status: first } = engine.requestRewrites(
					sample,
					'',
					{ kind: 'fix', problem: 'This sentence is wordy.' },
					'hover',
				);
				const report = () => {
					const s = engine.peek<string[]>(key);
					if (s?.state === 'ready') {
						new Notice(`Harper Plus works (${((Date.now() - started) / 1000).toFixed(1)}s):\n${s.value[0]}`, 10000);
					} else if (s?.state === 'error') {
						new Notice(`Harper Plus test failed: ${s.message}`, 10000);
					}
				};
				if (first.state !== 'pending') report();
				else {
					const off = engine.subscribe(key, () => {
						off();
						report();
					});
				}
			}),
		);

	new Setting(containerEl)
		.setName('When to generate rewrites')
		.setDesc(
			'On hover: only when a popup opens, then cached. Background: for every flag as you write, so popups open instantly but the model works more.',
		)
		.addDropdown((d) =>
			d
				.addOption('hover', 'On hover')
				.addOption('prefetch', 'Background prefetch')
				.setValue(ai.timing)
				.onChange((v) => save({ timing: v as AiSettings['timing'] })),
		);

	new Setting(containerEl)
		.setName('Rewrites on Harper suggestions')
		.setDesc('Show AI rewrites under Harper popups, like Grammarly.')
		.addToggle((t) => t.setValue(ai.rewrites).onChange((v) => save({ rewrites: v })))
		.addDropdown((d) =>
			d
				.addOption('sentence', 'Sentence-level flags only')
				.addOption('all', 'All flags except spelling')
				.setValue(ai.rewriteScope)
				.onChange((v) => save({ rewriteScope: v as AiSettings['rewriteScope'] })),
		);

	new Setting(containerEl)
		.setName('Clarity and conciseness')
		.setDesc('Let the AI flag wordy or unclear sentences that Harper misses.')
		.addToggle((t) => t.setValue(ai.clarity).onChange((v) => save({ clarity: v })));

	new Setting(containerEl)
		.setName('Word choice and fluency')
		.setDesc('Let the AI flag weak or imprecise words and awkward phrasing.')
		.addToggle((t) => t.setValue(ai.wordChoice).onChange((v) => save({ wordChoice: v })));

	new Setting(containerEl)
		.setName('Tone detection')
		.setDesc('Show the tone of the open note in the status bar.')
		.addToggle((t) => t.setValue(ai.toneDetection).onChange((v) => save({ toneDetection: v })));

	new Setting(containerEl)
		.setName('Tone rewrites')
		.setDesc('Show tone buttons (formal, casual, confident, friendly, concise) in popups and enable the rewrite commands.')
		.addToggle((t) => t.setValue(ai.toneRewrites).onChange((v) => save({ toneRewrites: v })));

	new Setting(containerEl)
		.setName('Number of rewrites')
		.addSlider((s) =>
			s
				.setLimits(1, 3, 1)
				.setDynamicTooltip()
				.setValue(ai.rewriteCount)
				.onChange((v) => save({ rewriteCount: v })),
		);

	new Setting(containerEl)
		.setName('Creativity')
		.setDesc('Model temperature. Lower is more literal, higher is more varied.')
		.addSlider((s) =>
			s
				.setLimits(0, 1, 0.1)
				.setDynamicTooltip()
				.setValue(ai.temperature)
				.onChange((v) => save({ temperature: v })),
		);

	new Setting(containerEl)
		.setName('Scan delay')
		.setDesc('How long (ms) a paragraph must sit unchanged before the AI scans it.')
		.addSlider((s) =>
			s
				.setLimits(500, 10000, 250)
				.setDynamicTooltip()
				.setValue(ai.scanIdleMs)
				.onChange((v) => save({ scanIdleMs: v })),
		);

	new Setting(containerEl)
		.setName('Style note')
		.setDesc('Optional instruction added to every prompt, for example "Keep my casual voice" or "Academic register".')
		.addTextArea((ta) => {
			ta.setValue(ai.styleNote);
			ta.inputEl.rows = 2;
			ta.inputEl.addEventListener('change', () => save({ styleNote: ta.getValue() }));
		});

	new Setting(containerEl)
		.setName('Forget ignored AI suggestions')
		.setDesc(`${ai.ignored.length} ignored.`)
		.addButton((b) => b.setButtonText('Reset').onClick(() => save({ ignored: [] })));

	void refreshModels(ai.ollamaUrl);
}
