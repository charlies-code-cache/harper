import {
	type FindingType,
	goalKey,
	type PromptSpec,
	type RewriteGoal,
	rewritePrompt,
	scanPrompt,
	type ToneReport,
	tonePrompt,
} from './prompts';
import type { AiSettings } from './settings';
import { cleanRewrites, hash, locate, proseParagraphs } from './text';

/** Minimal HTTP transport, injected so the engine never touches Obsidian or `fetch` directly. */
export type HttpTransport = (req: {
	url: string;
	method: 'GET' | 'POST';
	body?: string;
}) => Promise<{ status: number; json: any }>;

export type Status<T> =
	| { state: 'pending' }
	| { state: 'ready'; value: T }
	| { state: 'error'; message: string };

export type Priority = 'hover' | 'tone' | 'scan' | 'prefetch';

const PRIORITY_RANK: Record<Priority, number> = { hover: 3, tone: 2, scan: 1, prefetch: 0 };

/** Background jobs nobody asked about for this long are dropped from the queue. */
const STALE_MS = 60_000;
const CACHE_LIMIT = 500;

type Job = {
	key: string;
	priority: Priority;
	requestedAt: number;
	run: () => Promise<void>;
};

/** One AI-detected problem, positioned in the text that was scanned. */
export type Finding = {
	from: number;
	to: number;
	quote: string;
	type: FindingType;
	reason: string;
	/** Hash of the flagged text, used for ignoring. */
	id: string;
	/** The paragraph the finding came from, used as rewrite context. */
	paragraph: string;
};

/** Talks to Ollama, queues requests so only one generation runs at a time, and caches every result. */
export default class AiEngine {
	private http: HttpTransport;
	private getSettings: () => AiSettings;
	private cache = new Map<string, Status<unknown>>();
	private listeners = new Map<string, Set<() => void>>();
	private queue: Job[] = [];
	private running = false;
	private firstSeen = new Map<string, number>();
	private scanTimer: ReturnType<typeof setTimeout> | null = null;
	private liveScanKeys = new Set<string>();

	constructor(http: HttpTransport, getSettings: () => AiSettings) {
		this.http = http;
		this.getSettings = getSettings;
		this.restore();
	}

	private static STORAGE_KEY = 'harper-plus-ai-cache-v1';
	private saveTimer: ReturnType<typeof setTimeout> | null = null;

	/** Loads finished results saved by an earlier session, so flags come back instantly. */
	private restore() {
		try {
			const raw = globalThis.localStorage?.getItem(AiEngine.STORAGE_KEY);
			if (!raw) return;
			for (const [key, value] of JSON.parse(raw) as [string, unknown][]) {
				this.cache.set(key, { state: 'ready', value });
			}
		} catch {
			// Storage is optional.
		}
	}

	private schedulePersist() {
		if (this.saveTimer) return;
		this.saveTimer = setTimeout(() => {
			this.saveTimer = null;
			try {
				const ready = [...this.cache.entries()]
					.filter(([, s]) => s.state === 'ready')
					.slice(-CACHE_LIMIT)
					.map(([k, s]) => [k, (s as { value: unknown }).value]);
				globalThis.localStorage?.setItem(AiEngine.STORAGE_KEY, JSON.stringify(ready));
			} catch {
				// Storage is optional.
			}
		}, 2000);
	}

	private get settings(): AiSettings {
		return this.getSettings();
	}

	/** Drops every cached result, e.g. after the model or prompt settings change. */
	public clearCache() {
		this.cache.clear();
		this.queue = [];
		this.firstSeen.clear();
	}

	public subscribe(key: string, cb: () => void): () => void {
		let set = this.listeners.get(key);
		if (!set) {
			set = new Set();
			this.listeners.set(key, set);
		}
		set.add(cb);
		return () => set?.delete(cb);
	}

	private emit(key: string) {
		for (const cb of this.listeners.get(key) ?? []) {
			try {
				cb();
			} catch (e) {
				console.error('Harper Plus listener failed', e);
			}
		}
	}

	private remember(key: string, status: Status<unknown>) {
		this.cache.delete(key);
		this.cache.set(key, status);
		while (this.cache.size > CACHE_LIMIT) {
			const oldest = this.cache.keys().next().value;
			if (oldest === undefined) break;
			this.cache.delete(oldest);
		}
		this.emit(key);
		if (status.state === 'ready') this.schedulePersist();
	}

	public peek<T>(key: string): Status<T> | undefined {
		return this.cache.get(key) as Status<T> | undefined;
	}

	/** Returns the cached status for `key`, queuing `produce` if there is none yet. */
	private request<T>(key: string, priority: Priority, produce: () => Promise<T>): Status<T> {
		const cached = this.cache.get(key) as Status<T> | undefined;
		if (cached && cached.state !== 'pending') return cached;

		const existing = this.queue.find((j) => j.key === key);
		if (existing) {
			existing.requestedAt = Date.now();
			if (PRIORITY_RANK[priority] > PRIORITY_RANK[existing.priority]) existing.priority = priority;
			return { state: 'pending' };
		}
		if (cached?.state === 'pending') return cached;

		this.cache.set(key, { state: 'pending' });
		this.queue.push({
			key,
			priority,
			requestedAt: Date.now(),
			run: async () => {
				try {
					this.remember(key, { state: 'ready', value: await produce() });
				} catch (e) {
					this.remember(key, { state: 'error', message: errorMessage(e, this.settings.ollamaUrl) });
				}
			},
		});
		void this.pump();
		return { state: 'pending' };
	}

	private async pump() {
		if (this.running) return;
		this.running = true;
		try {
			while (this.queue.length > 0) {
				const now = Date.now();
				this.queue = this.queue.filter((j) => {
					// Only speculative prefetches expire; scans and hovers always finish.
					const keep = j.priority !== 'prefetch' || now - j.requestedAt < STALE_MS;
					if (!keep) this.cache.delete(j.key);
					return keep;
				});
				this.queue.sort(
					(a, b) =>
						PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority] || b.requestedAt - a.requestedAt,
				);
				const job = this.queue.shift();
				if (!job) break;
				await job.run();
			}
		} finally {
			this.running = false;
		}
	}

	private async chat(spec: PromptSpec): Promise<any> {
		const s = this.settings;
		const res = await this.http({
			url: `${trimUrl(s.ollamaUrl)}/api/chat`,
			method: 'POST',
			body: JSON.stringify({
				model: s.model,
				messages: spec.messages,
				stream: false,
				format: spec.format,
				keep_alive: '15m',
				options: { temperature: s.temperature, num_predict: spec.numPredict },
			}),
		});
		if (res.status !== 200) {
			throw new Error(res.json?.error ?? `Ollama returned HTTP ${res.status}`);
		}
		const content: string = res.json?.message?.content ?? '';
		try {
			return JSON.parse(content);
		} catch {
			const m = /\{[\s\S]*\}/.exec(content);
			if (m) return JSON.parse(m[0]);
			throw new Error('The model did not return valid JSON');
		}
	}

	/** Lists installed model names from Ollama's `/api/tags`. */
	public async listModels(url?: string): Promise<string[]> {
		const res = await this.http({ url: `${trimUrl(url ?? this.settings.ollamaUrl)}/api/tags`, method: 'GET' });
		if (res.status !== 200) throw new Error(`Ollama returned HTTP ${res.status}`);
		return ((res.json?.models ?? []) as { name: string }[]).map((m) => m.name).sort();
	}

	public rewriteKey(target: string, goal: RewriteGoal): string {
		const s = this.settings;
		return `rw:${s.model}:${s.rewriteCount}:${hash(s.styleNote)}:${hash(goalKey(goal))}:${hash(target)}`;
	}

	public requestRewrites(
		target: string,
		context: string,
		goal: RewriteGoal,
		priority: Priority,
	): { key: string; status: Status<string[]> } {
		const key = this.rewriteKey(target, goal);
		const status = this.request<string[]>(key, priority, async () => {
			const s = this.settings;
			const out = await this.chat(rewritePrompt(target, context, goal, s.rewriteCount, s.styleNote));
			const rewrites = cleanRewrites(target, out?.rewrites, s.rewriteCount);
			if (rewrites.length === 0) throw new Error('No rewrites came back');
			return rewrites;
		});
		return { key, status };
	}

	public toneKey(text: string): string {
		return `tone:${this.settings.model}:${hash(text)}`;
	}

	public requestTone(text: string, priority: Priority = 'tone'): { key: string; status: Status<ToneReport> } {
		const key = this.toneKey(text);
		const status = this.request<ToneReport>(key, priority, async () => {
			const out = await this.chat(tonePrompt(text.slice(0, 6000), this.settings.styleNote));
			return {
				tones: Array.isArray(out?.tones) ? out.tones.map(String).slice(0, 3) : [],
				formality: String(out?.formality ?? ''),
				confidence: String(out?.confidence ?? ''),
				summary: String(out?.summary ?? ''),
			};
		});
		return { key, status };
	}

	/** Problem types the scan looks for under the current settings. */
	public scanTypes(): FindingType[] {
		const s = this.settings;
		const types: FindingType[] = [];
		if (s.clarity) types.push('clarity', 'conciseness');
		if (s.wordChoice) types.push('word_choice', 'fluency');
		return types;
	}

	/**
	 * Returns cached findings for `text` and queues scans for paragraphs that have settled.
	 * `onChange` fires whenever new findings arrive or a paragraph becomes ready to scan.
	 */
	public scan(text: string, onChange: () => void): Finding[] {
		const s = this.settings;
		const types = this.scanTypes();
		if (!s.enabled || types.length === 0) return [];

		const findings: Finding[] = [];
		const now = Date.now();
		let soonest = Number.POSITIVE_INFINITY;
		const paragraphs = proseParagraphs(text).slice(0, s.maxParagraphsPerNote);
		const live = new Set<string>();

		for (const p of paragraphs) {
			const key = `scan:${s.model}:${types.join(',')}:${hash(s.styleNote)}:${hash(p.text)}`;
			this.liveScanKeys.add(key);
			live.add(key);
			const cached = this.peek<Omit<Finding, 'from' | 'to'>[]>(key);
			if (cached?.state === 'ready') {
				for (const f of cached.value) {
					const r = locate(p.text, f.quote);
					if (r) findings.push({ ...f, from: p.from + r.from, to: p.from + r.to });
				}
				continue;
			}
			if (cached) continue;

			const seen = this.firstSeen.get(key) ?? now;
			this.firstSeen.set(key, seen);
			const waited = now - seen;
			if (waited < s.scanIdleMs) {
				soonest = Math.min(soonest, s.scanIdleMs - waited);
				continue;
			}
			const unsubscribe = this.subscribe(key, () => {
				unsubscribe();
				onChange();
			});
			this.request(key, 'scan', async () => {
				const out = await this.chat(scanPrompt(p.text, types, this.settings.styleNote));
				const issues: Omit<Finding, 'from' | 'to'>[] = [];
				for (const issue of Array.isArray(out?.issues) ? out.issues : []) {
					if (typeof issue?.quote !== 'string' || !types.includes(issue.type)) continue;
					const r = locate(p.text, issue.quote);
					if (!r) continue;
					const quote = p.text.slice(r.from, r.to);
					if (quote.split(/\s+/).length < 2 && issue.type !== 'word_choice') continue;
					issues.push({
						quote,
						type: issue.type,
						reason: String(issue.reason ?? '').trim(),
						id: hash(quote),
						paragraph: p.text,
					});
				}
				return issues;
			});
		}

		for (const key of this.firstSeen.keys()) {
			if (!live.has(key)) this.firstSeen.delete(key);
		}

		if (Number.isFinite(soonest)) {
			if (this.scanTimer) clearTimeout(this.scanTimer);
			this.scanTimer = setTimeout(onChange, soonest + 50);
		}

		const ignored = new Set(s.ignored);
		return findings.filter((f) => !ignored.has(f.id));
	}
}

function trimUrl(url: string): string {
	return url.trim().replace(/\/+$/, '');
}

function errorMessage(e: unknown, url: string): string {
	const msg = e instanceof Error ? e.message : String(e);
	if (/ECONNREFUSED|Failed to fetch|net::|ERR_CONNECTION/i.test(msg)) {
		return `Ollama is not reachable at ${url}`;
	}
	return msg;
}
