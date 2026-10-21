/**
 * B-688: minimal unified line diff for the model-config preview. Config files
 * are small (the service refuses anything over MAX_CONFIG_BYTES), so a plain
 * LCS table is fine; above MAX_DIFF_LINES the diff degrades to "replace all"
 * rather than spending quadratic time.
 */

export const MAX_DIFF_LINES = 4000;

type Op = { kind: ' ' | '-' | '+'; text: string };

function splitLines(text: string): string[] {
    if (text === '') return [];
    const lines = text.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    return lines;
}

function diffOps(a: string[], b: string[]): Op[] {
    if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) {
        return [...a.map(text => ({ kind: '-' as const, text })), ...b.map(text => ({ kind: '+' as const, text }))];
    }
    const n = a.length;
    const m = b.length;
    // lcs[i][j] = LCS length of a[i..] and b[j..]
    const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
            lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
        }
    }
    const ops: Op[] = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
        if (a[i] === b[j]) { ops.push({ kind: ' ', text: a[i] }); i++; j++; }
        else if (lcs[i + 1][j] >= lcs[i][j + 1]) { ops.push({ kind: '-', text: a[i] }); i++; }
        else { ops.push({ kind: '+', text: b[j] }); j++; }
    }
    while (i < n) ops.push({ kind: '-', text: a[i++] });
    while (j < m) ops.push({ kind: '+', text: b[j++] });
    return ops;
}

/**
 * Unified diff (`--- <label>` / `+++ <label>` / `@@` hunks, 3 lines of
 * context). Returns '' when the texts are equal.
 */
export function unifiedDiff(oldText: string, newText: string, label: string, context = 3): string {
    if (oldText === newText) return '';
    const a = splitLines(oldText);
    const b = splitLines(newText);
    const ops = diffOps(a, b);
    const changed = ops.map(op => op.kind !== ' ');
    if (!changed.some(Boolean)) {
        // Only a trailing-newline difference.
        return `--- ${label}\n+++ ${label}\n@@ trailing newline changed @@\n`;
    }
    const out: string[] = [`--- ${oldText === '' ? '/dev/null' : label}`, `+++ ${label}`];
    let k = 0;
    while (k < ops.length) {
        if (!changed[k]) { k++; continue; }
        let start = Math.max(0, k - context);
        let end = k;
        // extend the hunk while the next change is within 2*context lines
        while (end < ops.length) {
            if (changed[end]) { end++; continue; }
            let next = end;
            while (next < ops.length && !changed[next]) next++;
            if (next < ops.length && next - end <= context * 2) { end = next; continue; }
            break;
        }
        const stop = Math.min(ops.length, end + context);
        let oldStart = 1;
        let newStart = 1;
        for (let p = 0; p < start; p++) {
            if (ops[p].kind !== '+') oldStart++;
            if (ops[p].kind !== '-') newStart++;
        }
        const slice = ops.slice(start, stop);
        const oldCount = slice.filter(op => op.kind !== '+').length;
        const newCount = slice.filter(op => op.kind !== '-').length;
        out.push(`@@ -${oldCount ? oldStart : oldStart - 1},${oldCount} +${newCount ? newStart : newStart - 1},${newCount} @@`);
        for (const op of slice) out.push(`${op.kind}${op.text}`);
        k = stop;
        start = stop;
    }
    return `${out.join('\n')}\n`;
}
