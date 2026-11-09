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
