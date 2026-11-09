import type { Tone } from './settings';

/** A chat message in Ollama's `/api/chat` format. */
export type ChatMessage = { role: 'system' | 'user'; content: string };

export type PromptSpec = {
	messages: ChatMessage[];
	/** JSON schema handed to Ollama's structured output. */
	format: object;
	/** Upper bound on generated tokens. */
	numPredict: number;
};

const SYSTEM = [
	'You are a careful writing assistant inside a grammar checker.',
	"Keep the author's meaning, voice, and facts. Never invent information.",
	'Keep Markdown, links, names, numbers, and quoted material exactly as written.',
	'Do not use em dashes.',
	'Reply with JSON only.',
].join(' ');

function system(styleNote: string): ChatMessage {
	const note = styleNote.trim();
	return { role: 'system', content: note.length > 0 ? `${SYSTEM} Author preference: ${note}` : SYSTEM };
}

/** What a rewrite should accomplish. */
export type RewriteGoal =
	| { kind: 'fix'; problem: string }
	| { kind: 'tone'; tone: Tone }
	| { kind: 'finding'; findingType: FindingType; reason: string };

export function goalKey(goal: RewriteGoal): string {
	switch (goal.kind) {
		case 'fix':
			return `fix:${goal.problem}`;
		case 'tone':
			return `tone:${goal.tone}`;
		case 'finding':
			return `finding:${goal.findingType}:${goal.reason}`;
	}
}

function goalInstruction(goal: RewriteGoal): string {
	switch (goal.kind) {
		case 'fix':
			return `A grammar checker flagged this problem: "${goal.problem}". Rewrite the TEXT so the problem is gone. If the problem is length, split or tighten it.`;
		case 'tone':
			return `Rewrite the TEXT so it sounds more ${goal.tone}, without changing what it says.`;
		case 'finding':
			return `The TEXT has a ${findingLabel(goal.findingType).toLowerCase()} problem: ${goal.reason}. Rewrite it to fix that.`;
	}
}

export function rewritePrompt(
	target: string,
	context: string,
	goal: RewriteGoal,
	count: number,
	styleNote: string,
): PromptSpec {
	const contextBlock =
		context.trim().length > 0 && context.trim() !== target.trim()
			? `Surrounding paragraph, for context only (do not rewrite it):\n${context}\n\n`
			: '';
	return {
		messages: [
			system(styleNote),
			{
				role: 'user',
				content: `${goalInstruction(goal)}\nGive ${count} distinct rewrite${count === 1 ? '' : 's'}, best first. Each one must be a drop-in replacement for the TEXT only, with no commentary.\n\n${contextBlock}TEXT:\n${target}`,
			},
		],
		format: {
			type: 'object',
			properties: {
				rewrites: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: count },
			},
			required: ['rewrites'],
		},
		numPredict: 120 + Math.ceil(target.length / 3) * count,
	};
}

export type FindingType = 'clarity' | 'conciseness' | 'word_choice' | 'fluency';

export function findingLabel(type: FindingType): string {
	switch (type) {
		case 'clarity':
			return 'Clarity';
		case 'conciseness':
			return 'Conciseness';
		case 'word_choice':
			return 'Word choice';
		case 'fluency':
			return 'Fluency';
	}
}

export function scanPrompt(paragraph: string, types: FindingType[], styleNote: string): PromptSpec {
	const descriptions: Record<FindingType, string> = {
		clarity: 'clarity (hard to follow, vague, or ambiguous)',
		conciseness: 'conciseness (wordy, padded, or redundant)',
		word_choice: 'word_choice (a weak, vague, or imprecise word that has a stronger option)',
		fluency: 'fluency (awkward or unnatural phrasing)',
	};
	return {
		messages: [
			system(styleNote),
			{
				role: 'user',
				content: `Review the PARAGRAPH for these problem types only: ${types.map((t) => descriptions[t]).join('; ')}.\nFlag at most 3 clear problems that a skilled editor would change. Ignore spelling, grammar, punctuation, citations, and personal style. If the writing is fine, return an empty list.\nFor each problem, copy the exact text span from the paragraph into "quote", character for character. For word_choice, quote only the weak word or short phrase; for the other types, quote the clause or sentence. Set "type", and give a "reason" under 12 words.\n\nPARAGRAPH:\n${paragraph}`,
			},
		],
		format: {
			type: 'object',
			properties: {
				issues: {
					type: 'array',
					maxItems: 3,
					items: {
						type: 'object',
						properties: {
							quote: { type: 'string' },
							type: { type: 'string', enum: types },
							reason: { type: 'string' },
						},
						required: ['quote', 'type', 'reason'],
					},
				},
			},
			required: ['issues'],
		},
		numPredict: 400,
	};
}

export type ToneReport = {
	tones: string[];
	formality: string;
	confidence: string;
	summary: string;
};

export function tonePrompt(text: string, styleNote: string): PromptSpec {
	return {
		messages: [
			system(styleNote),
			{
				role: 'user',
				content: `Describe how the TEXT sounds to a reader.\n"tones": up to 3 one-word tone labels, strongest first (for example confident, friendly, formal, casual, tentative, urgent, enthusiastic, critical).\n"formality": one of very casual, casual, neutral, formal, very formal.\n"confidence": one of tentative, neutral, confident.\n"summary": one sentence under 20 words about the overall impression.\n\nTEXT:\n${text}`,
			},
		],
		format: {
			type: 'object',
			properties: {
				tones: { type: 'array', items: { type: 'string' }, maxItems: 3 },
				formality: { type: 'string' },
				confidence: { type: 'string' },
				summary: { type: 'string' },
			},
			required: ['tones', 'formality', 'confidence', 'summary'],
		},
		numPredict: 160,
	};
}
