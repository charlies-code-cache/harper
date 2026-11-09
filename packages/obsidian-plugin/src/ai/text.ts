/** Range helpers for picking what the AI rewrites. All offsets are UTF-16 indexes into `text`. */

export type Range = { from: number; to: number };

const TERMINATORS = '.!?';
const CLOSERS = '"\')]”’*_';

/** True when the character at `i` can begin a new sentence (so "pp. 34" or "e.g. this" do not split). */
function startsSentence(text: string, i: number): boolean {
	const ch = text[i];
	if (ch == null || ch === '\n') return true;
	return !/[a-z0-9(]/.test(ch);
}

/** Finds the sentence that contains `[from, to)`, bounded by sentence punctuation or line breaks. */
export function sentenceAround(text: string, from: number, to: number): Range {
	let start = Math.max(0, Math.min(from, text.length));
	while (start > 0) {
		const prev = text[start - 1];
		if (prev === '\n') break;
		if (/\s/.test(prev) && start >= 2 && startsSentence(text, start)) {
			let k = start - 2;
			while (k >= 0 && CLOSERS.includes(text[k])) k--;
			if (k >= 0 && TERMINATORS.includes(text[k])) break;
		}
		start--;
	}
	// Skip Markdown list markers, quote markers, and leading spaces.
	const lead = /^(\s*(?:[-*+]|\d+[.)]|>)\s+)/.exec(text.slice(start, Math.max(start, from)));
	if (lead) start += lead[1].length;
	while (start < from && /\s/.test(text[start])) start++;

	let end = Math.max(start, Math.min(to, text.length));
	while (end < text.length) {
		const ch = text[end];
		if (ch === '\n') break;
		end++;
		if (TERMINATORS.includes(ch)) {
			while (end < text.length && CLOSERS.includes(text[end])) end++;
			if (end >= text.length) break;
			if (/\s/.test(text[end])) {
				let k = end;
				while (k < text.length && text[k] === ' ') k++;
				if (k >= text.length || startsSentence(text, k)) break;
			}
		}
	}
	while (end > start && /\s/.test(text[end - 1])) end--;
	return { from: start, to: end };
}

/** The line (Markdown paragraph) that contains `pos`. */
export function lineAround(text: string, pos: number): Range {
	const from = text.lastIndexOf('\n', Math.max(0, pos - 1)) + 1;
	let to = text.indexOf('\n', pos);
	if (to < 0) to = text.length;
	return { from, to };
}

export type Paragraph = Range & { text: string };

/** Prose paragraphs worth sending to the AI scan: skips frontmatter, code, headings, tables, and short lines. */
export function proseParagraphs(text: string): Paragraph[] {
	const out: Paragraph[] = [];
	let inCode = false;
	let inFrontmatter = false;
	let offset = 0;
	const lines = text.split('\n');
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const from = offset;
		offset += line.length + 1;
		const trimmed = line.trim();
		if (i === 0 && trimmed === '---') {
			inFrontmatter = true;
			continue;
		}
		if (inFrontmatter) {
			if (trimmed === '---') inFrontmatter = false;
			continue;
		}
		if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
			inCode = !inCode;
			continue;
		}
		if (inCode) continue;
		if (/^(#|\||!\[|<|%%|\$\$)/.test(trimmed)) continue;
		const words = trimmed.split(/\s+/).filter((w) => /[A-Za-z]/.test(w));
		if (words.length < 8 || trimmed.length > 2000) continue;
		out.push({ from, to: from + line.length, text: line });
	}
	return out;
}

/** Finds `quote` in `haystack`, falling back to a case and whitespace insensitive match. */
export function locate(haystack: string, quote: string): Range | null {
	const q = quote.trim().replace(/^["“]|["”]$/g, '');
	if (q.length < 3) return null;
	const exact = haystack.indexOf(q);
	if (exact >= 0) return { from: exact, to: exact + q.length };
	const escaped = q
		.split(/\s+/)
		.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
		.join('\\s+');
	const m = new RegExp(escaped, 'i').exec(haystack);
	return m ? { from: m.index, to: m.index + m[0].length } : null;
}

/** Small stable string hash (FNV-1a) for cache keys. */
export function hash(s: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(36);
}

/** Cleans a model rewrite: trims quotes and drops results identical to the original. */
export function cleanRewrites(original: string, rewrites: unknown, count: number): string[] {
	if (!Array.isArray(rewrites)) return [];
	const seen = new Set<string>([original.trim()]);
	const out: string[] = [];
	for (const r of rewrites) {
		if (typeof r !== 'string') continue;
		let s = r.trim();
		if (s.length >= 2 && /^["“]/.test(s) && /["”]$/.test(s) && !/^["“]/.test(original.trim())) {
			s = s.slice(1, -1).trim();
		}
		if (s.length === 0 || seen.has(s)) continue;
		seen.add(s);
		out.push(s);
		if (out.length >= count) break;
	}
	return out;
}
