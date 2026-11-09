/** When AI rewrites are generated. */
export type AiTiming = 'hover' | 'prefetch';

/** Which Harper lints get AI rewrites underneath their own suggestions. */
export type AiRewriteScope = 'sentence' | 'all';

export type AiSettings = {
	/** Master switch for every Harper Plus AI feature. */
	enabled: boolean;
	ollamaUrl: string;
	model: string;
	timing: AiTiming;
	/** Feature 1: rewrites on Harper's own popups. */
	rewrites: boolean;
	rewriteScope: AiRewriteScope;
	/** Feature 2: AI lints for wordy or unclear sentences. */
	clarity: boolean;
	/** Feature 3: tone detection for the open note. */
	toneDetection: boolean;
	/** Feature 3: tone rewrite chips and commands. */
	toneRewrites: boolean;
	/** Feature 4: AI lints for weak words and awkward phrasing. */
	wordChoice: boolean;
	/** How many rewrites to ask for (1 to 3). */
	rewriteCount: number;
	/** Sampling temperature passed to Ollama. */
	temperature: number;
	/** How long a paragraph must stay unchanged before the AI scans it, in milliseconds. */
	scanIdleMs: number;
	/** Upper bound on how many paragraphs one note can have scanned. */
	maxParagraphsPerNote: number;
	/** Optional extra instruction appended to every prompt (e.g. "Keep a casual voice"). */
	styleNote: string;
	/** Ignored AI findings, keyed by a hash of the flagged text. */
	ignored: string[];
};

export const DEFAULT_AI_SETTINGS: AiSettings = {
	enabled: true,
	ollamaUrl: 'http://localhost:11434',
	model: 'gemma3:4b',
	timing: 'hover',
	rewrites: true,
	rewriteScope: 'sentence',
	clarity: true,
	toneDetection: true,
	toneRewrites: true,
	wordChoice: true,
	rewriteCount: 3,
	temperature: 0.5,
	scanIdleMs: 2500,
	maxParagraphsPerNote: 40,
	styleNote: '',
	ignored: [],
};

export function withAiDefaults(partial: Partial<AiSettings> | undefined | null): AiSettings {
	const merged = { ...DEFAULT_AI_SETTINGS, ...(partial ?? {}) };
	merged.rewriteCount = Math.min(3, Math.max(1, Math.round(merged.rewriteCount)));
	merged.ignored = [...(merged.ignored ?? [])];
	return merged;
}

/** Tones offered for tone rewrites. */
export const TONES = [
	'formal',
	'casual',
	'confident',
	'friendly',
	'concise',
	'diplomatic',
	'persuasive',
] as const;

export type Tone = (typeof TONES)[number];

export function toneLabel(tone: Tone): string {
	return tone.charAt(0).toUpperCase() + tone.slice(1);
}
