<script lang="ts">
import { Button, Checkbox, CheckIcon, Select, SettingRow } from 'components';
import { onMount } from 'svelte';
import { type AiConfig, Client } from '$lib/client';

let ai: AiConfig | null = null;
let models: string[] = [];
let status = '';
let error = '';
let saving = false;
let testing = false;
let testResult = '';

type Toggle = 'enabled' | 'rewrites' | 'clarity' | 'word_choice' | 'tone_detection' | 'tone_rewrites';

const FEATURES: { key: Toggle; title: string; description: string }[] = [
	{
		key: 'rewrites',
		title: 'Rewrites on Harper suggestions',
		description: 'Show 1 to 3 AI rewrites in Harper popups. Click one to apply it.',
	},
	{
		key: 'clarity',
		title: 'Clarity and conciseness',
		description: 'Let the AI flag wordy or unclear sentences that Harper misses.',
	},
	{
		key: 'word_choice',
		title: 'Word choice and fluency',
		description: 'Let the AI flag weak or imprecise words and awkward phrasing.',
	},
	{
		key: 'tone_detection',
		title: 'Tone detection',
		description: 'Show the tone of the text you are writing in each popup.',
	},
	{
		key: 'tone_rewrites',
		title: 'Tone rewrites',
		description: 'Show Formal, Casual, Confident, Friendly, and Concise buttons in popups.',
	},
];

onMount(() => {
	void load();
});

async function load() {
	try {
		ai = await Client.getAiConfig();
		await refreshModels();
	} catch (e) {
		error = `Unable to load AI settings: ${e}`;
	}
}

async function refreshModels() {
	if (ai == null) return;
	status = 'Checking Ollama...';
	try {
		models = await Client.listOllamaModels(ai.ollama_url);
		status =
			models.length > 0
				? `Connected to Ollama. ${models.length} model${models.length === 1 ? '' : 's'} installed.`
				: 'Connected, but no models are installed. Run "ollama pull gemma3:4b".';
	} catch (e) {
		models = [];
		status = `Could not reach Ollama at ${ai.ollama_url}: ${e}`;
	}
}

async function save(patch: Partial<AiConfig>) {
	if (ai == null) return;
	const previous = ai;
	ai = { ...ai, ...patch };
	saving = true;
	error = '';
	try {
		await Client.setAiConfig(ai);
	} catch (e) {
		ai = previous;
		error = `Unable to save AI settings: ${e}`;
	} finally {
		saving = false;
	}
}

async function runTest() {
	if (ai == null) return;
	testing = true;
	testResult = 'Asking the model for a sample rewrite...';
	try {
		const [rewrite, seconds] = await Client.testAi(ai);
		testResult = `Works (${seconds.toFixed(1)}s): ${rewrite}`;
	} catch (e) {
		testResult = `Test failed: ${e}`;
	} finally {
		testing = false;
	}
}

$: modelOptions = ai == null ? [] : models.includes(ai.model) ? models : [ai.model, ...models];
</script>

<section>
  {#if ai == null}
    <p class="result-summary">{error || 'Loading AI settings...'}</p>
  {:else}
    <div class="stanza">
      <div class="eyebrow">Harper Plus AI</div>
      <p class="section-copy">
        Writing help from a local Ollama model: rewrites, clarity, tone, and word choice. Nothing
        leaves this computer.
      </p>
      <div class="rows">
        <SettingRow top>
          <strong>Enable AI features</strong>
          <p>Master switch for everything on this page.</p>
          <Checkbox
            slot="control"
            appearance="settings"
            checked={ai.enabled}
            disabled={saving}
            on:click={() => save({ enabled: !ai?.enabled })}
          >
            {#if ai.enabled}<CheckIcon className="control-icon" />{/if}
          </Checkbox>
        </SettingRow>
      </div>
    </div>

    <div class="divider"></div>

    <div class="stanza">
      <div class="eyebrow">Model</div>
      <div class="inline-row">
        <label for="ollama-url">Ollama URL:</label>
        <input
          id="ollama-url"
          class="select wide"
          value={ai.ollama_url}
          on:change={async (event) => {
            const value = event.currentTarget.value.trim();
            await save({ ollama_url: value || 'http://localhost:11434' });
            await refreshModels();
          }}
        />
      </div>
      <div class="inline-row">
        <label for="ollama-model">Model:</label>
        <Select
          unstyled
          id="ollama-model"
          class="select wide"
          value={ai.model}
          on:change={(event) =>
            save({ model: (event.detail.currentTarget as HTMLSelectElement).value })}
        >
          {#each modelOptions as name}
            <option value={name}>{name}</option>
          {/each}
        </Select>
        <Button unstyled class="button" type="button" on:click={refreshModels}>Refresh</Button>
        <Button unstyled class="button" type="button" disabled={testing} on:click={runTest}>
          {testing ? 'Testing...' : 'Test'}
        </Button>
      </div>
      <p class="result-summary">{status}</p>
      {#if testResult}<p class="result-summary">{testResult}</p>{/if}
    </div>

    <div class="divider"></div>

    <div class="stanza">
      <div class="eyebrow">When to generate</div>
      <div class="inline-row">
        <label for="ai-timing">Rewrites:</label>
        <Select
          unstyled
          id="ai-timing"
          class="select wide"
          value={ai.timing}
          on:change={(event) =>
            save({
              timing: (event.detail.currentTarget as HTMLSelectElement).value as AiConfig['timing'],
            })}
        >
          <option value="hover">On hover (generate when a popup opens, then cache)</option>
          <option value="prefetch">Background prefetch (generate for every flag as you write)</option>
        </Select>
      </div>
      <div class="inline-row">
        <label for="ai-scope">Which flags:</label>
        <Select
          unstyled
          id="ai-scope"
          class="select wide"
          value={ai.rewrite_scope}
          on:change={(event) =>
            save({
              rewrite_scope: (event.detail.currentTarget as HTMLSelectElement)
                .value as AiConfig['rewrite_scope'],
            })}
        >
          <option value="sentence">Sentence-level flags only</option>
          <option value="all">All flags except spelling</option>
        </Select>
      </div>
    </div>

    <div class="divider"></div>

    <div class="stanza">
      <div class="eyebrow">Features</div>
      <div class="rows">
        {#each FEATURES as feature}
          <SettingRow top>
            <strong>{feature.title}</strong>
            <p>{feature.description}</p>
            <Checkbox
              slot="control"
              appearance="settings"
              checked={ai[feature.key]}
              disabled={saving}
              on:click={() => save({ [feature.key]: !ai?.[feature.key] })}
            >
              {#if ai[feature.key]}<CheckIcon className="control-icon" />{/if}
            </Checkbox>
          </SettingRow>
        {/each}
      </div>
    </div>

    <div class="divider"></div>

    <div class="stanza">
      <div class="eyebrow">Tuning</div>
      <div class="inline-row">
        <label for="ai-count">Number of rewrites:</label>
        <Select
          unstyled
          id="ai-count"
          class="select"
          value={String(ai.rewrite_count)}
          on:change={(event) =>
            save({
              rewrite_count: Number((event.detail.currentTarget as HTMLSelectElement).value),
            })}
        >
          <option value="1">1</option>
          <option value="2">2</option>
          <option value="3">3</option>
        </Select>
      </div>
      <div class="inline-row">
        <label for="ai-temp">Creativity (0 to 1):</label>
        <input
          id="ai-temp"
          class="select"
          type="number"
          min="0"
          max="1"
          step="0.1"
          value={String(ai.temperature)}
          on:change={(event) => {
            const v = Number(event.currentTarget.value);
            if (Number.isFinite(v)) save({ temperature: Math.min(1, Math.max(0, v)) });
          }}
        />
      </div>
      <div class="inline-row">
        <label for="ai-idle">Scan delay:</label>
        <input
          id="ai-idle"
          class="select"
          type="number"
          min="500"
          step="250"
          value={String(ai.scan_idle_ms)}
          on:change={(event) => {
            const v = Number(event.currentTarget.value);
            if (Number.isInteger(v) && v >= 0) save({ scan_idle_ms: v });
          }}
        />
        <span>ms a paragraph must sit unchanged before the AI scans it</span>
      </div>
      <p class="section-copy">
        Style note, added to every prompt (for example "Keep my casual voice"):
      </p>
      <textarea
        class="select wide"
        rows={2}
        value={ai.style_note}
        on:change={(event) =>
          save({ style_note: event.currentTarget.value })}
      ></textarea>
      <div class="inline-row">
        <Button
          unstyled
          class="button"
          type="button"
          disabled={ai.ignored.length === 0}
          on:click={() => save({ ignored: [] })}
        >
          Forget {ai.ignored.length} ignored AI suggestion{ai.ignored.length === 1 ? '' : 's'}
        </Button>
      </div>
      {#if error}<p class="result-summary">{error}</p>{/if}
    </div>
  {/if}
</section>
