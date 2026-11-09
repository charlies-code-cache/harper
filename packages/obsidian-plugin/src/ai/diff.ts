/** Word-level diff used to show rewrites the way Grammarly does: struck-out old words, bold new ones. */

export type DiffPart =
	| { kind: 'same'; text: string }
	| { kind: 'del'; text: string }
	| { kind: 'ins'; text: string };

function tokenize(s: string): string[] {
	return s.match(/[\p{L}\p{N}'’-]+|\s+|[^\s\p{L}\p{N}]/gu) ?? [];
}

/** Diffs `before` against `after`, grouping each run of changes into one deletion followed by one insertion. */
export function wordDiff(before: string, after: string): DiffPart[] {
	const a = tokenize(before);
	const b = tokenize(after);
	const n = a.length;
	const m = b.length;
	// LCS table, filled from the end so the walk below goes forward.
	const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
		}
	}

	type Op = { kind: DiffPart['kind']; text: string };
	const ops: Op[] = [];
	let i = 0;
	let j = 0;
	while (i < n || j < m) {
		if (i < n && j < m && a[i] === b[j]) {
			ops.push({ kind: 'same', text: a[i] });
			i++;
			j++;
		} else if (j < m && (i >= n || lcs[i][j + 1] >= lcs[i + 1][j])) {
			ops.push({ kind: 'ins', text: b[j] });
			j++;
		} else {
			ops.push({ kind: 'del', text: a[i] });
			i++;
		}
	}

	const parts: DiffPart[] = [];
	let k = 0;
	while (k < ops.length) {
		if (ops[k].kind === 'same') {
			const last = parts[parts.length - 1];
			if (last?.kind === 'same') last.text += ops[k].text;
			else parts.push({ kind: 'same', text: ops[k].text });
			k++;
			continue;
		}
		// Collect a cluster of changes, absorbing whitespace-only matches between them.
		let del = '';
		let ins = '';
		while (k < ops.length) {
			const op = ops[k];
			if (op.kind === 'del') del += op.text;
			else if (op.kind === 'ins') ins += op.text;
			else if (/^\s+$/.test(op.text) && ops[k + 1] && ops[k + 1].kind !== 'same') {
				del += op.text;
				ins += op.text;
			} else break;
			k++;
		}
		const lead = /^\s*/.exec(del.length > 0 ? del : ins)?.[0] ?? '';
		if (lead) {
			const last = parts[parts.length - 1];
			if (last?.kind === 'same') last.text += lead;
			else parts.push({ kind: 'same', text: lead });
		}
		if (del.trim()) parts.push({ kind: 'del', text: del.trim() });
		if (ins.trim()) parts.push({ kind: 'ins', text: ins.trim() });
		const trail = /\s*$/.exec(del.length > 0 ? del : ins)?.[0] ?? '';
		if (trail && trail !== lead) parts.push({ kind: 'same', text: trail });
	}
	return parts;
}

/** Share of the original text that a rewrite removes, from 0 to 1. */
export function changeRatio(parts: DiffPart[], before: string): number {
	const removed = parts.filter((p) => p.kind === 'del').reduce((n, p) => n + p.text.length, 0);
	return before.length === 0 ? 1 : removed / before.length;
}

/** One self-contained edit inside a rewrite, positioned in the original text. */
export type Cluster = {
	/** Offsets into the original text. */
	from: number;
	to: number;
	before: string;
	after: string;
};

/**
 * Splits a rewrite into separate edits (Grammarly shows each as its own small correction).
 * Pure insertions are attached to the word before them, so every edit has text to underline.
 */
export function changeClusters(before: string, after: string): Cluster[] {
	const a = tokenize(before);
	const b = tokenize(after);
	const n = a.length;
	const m = b.length;
	const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
		}
	}
	type Op = { kind: 'same' | 'del' | 'ins'; text: string; pos: number };
	const ops: Op[] = [];
	let i = 0;
	let j = 0;
	let pos = 0;
	while (i < n || j < m) {
		if (i < n && j < m && a[i] === b[j]) {
			ops.push({ kind: 'same', text: a[i], pos });
			pos += a[i].length;
			i++;
			j++;
		} else if (j < m && (i >= n || lcs[i][j + 1] >= lcs[i + 1][j])) {
			ops.push({ kind: 'ins', text: b[j], pos });
			j++;
		} else {
			ops.push({ kind: 'del', text: a[i], pos });
			pos += a[i].length;
			i++;
		}
	}

	const clusters: Cluster[] = [];
	let k = 0;
	while (k < ops.length) {
		if (ops[k].kind === 'same') {
			k++;
			continue;
		}
		const from = ops[k].pos;
		let to = from;
		let ins = '';
		while (k < ops.length) {
			const op = ops[k];
			if (op.kind === 'del') to = op.pos + op.text.length;
			else if (op.kind === 'ins') ins += op.text;
			else if (/^\s+$/.test(op.text) && ops[k + 1] && ops[k + 1].kind !== 'same') {
				to = op.pos + op.text.length;
				ins += op.text;
			} else break;
			k++;
		}
		let cFrom = from;
		let del = before.slice(from, to);
		// Trim whitespace that both sides share at the edges.
		while (del.length > 0 && ins.length > 0 && /\s/.test(del[0]) && del[0] === ins[0]) {
			del = del.slice(1);
			ins = ins.slice(1);
			cFrom++;
		}
		while (del.length > 0 && ins.length > 0 && /\s/.test(del.at(-1)!) && del.at(-1) === ins.at(-1)) {
			del = del.slice(0, -1);
			ins = ins.slice(0, -1);
		}
		let cTo = cFrom + del.length;
		if (del.trim().length === 0) {
			// Pure insertion: include the previous word.
			let end = cFrom;
			while (end > 0 && /\s/.test(before[end - 1])) end--;
			let start = end;
			while (start > 0 && !/\s/.test(before[start - 1])) start--;
			if (end === start) continue;
			ins = before.slice(start, cFrom) + ins;
			del = before.slice(start, cTo);
			cFrom = start;
			cTo = start + del.length;
		}
		if (del === ins) continue;
		clusters.push({ from: cFrom, to: cTo, before: del, after: ins });
	}
	// Edits separated by one or two short words read better as one change.
	const merged: Cluster[] = [];
	for (const c of clusters) {
		const last = merged.at(-1);
		const gap = last ? before.slice(last.to, c.from) : '';
		if (last && gap.length <= 14 && gap.trim().split(/\s+/).filter(Boolean).length <= 2) {
			last.after = last.after + gap + c.after;
			last.before = before.slice(last.from, c.to);
			last.to = c.to;
		} else merged.push({ ...c });
	}
	return merged;
}

/** A few words of context on each side of an edit, for a compact card. */
export function clusterContext(text: string, c: Cluster, words = 3): { lead: string; trail: string } {
	let start = c.from;
	let count = 0;
	while (start > 0 && count < words) {
		start--;
		if (/\s/.test(text[start]) && start > 0 && !/\s/.test(text[start - 1])) count++;
	}
	if (start > 0) start++;
	let end = c.to;
	count = 0;
	while (end < text.length && count < words) {
		if (/\s/.test(text[end]) && end + 1 < text.length && !/\s/.test(text[end + 1])) count++;
		if (count < words) end++;
	}
	const lead = (start > 0 ? '...' : '') + text.slice(start, c.from);
	const trail = text.slice(c.to, end) + (end < text.length ? '...' : '');
	return { lead, trail };
}
