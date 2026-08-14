/**
 * Minimal line-level diff (LCS) used by the Edit/MultiEdit/Write tool views.
 * Produces a unified-style row list with +/- context markers. Good enough for
 * the short hunks tool edits produce; not a full Myers diff.
 */
export type DiffRow = {
    type: 'add' | 'del' | 'ctx';
    text: string;
    oldNo: number | null;
    newNo: number | null;
};

export function lineDiff(oldText: string, newText: string): DiffRow[] {
    const a = oldText.length ? oldText.split('\n') : [];
    const b = newText.length ? newText.split('\n') : [];

    // LCS table
    const n = a.length;
    const m = b.length;
    const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
            dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
    }

    const rows: DiffRow[] = [];
    let i = 0;
    let j = 0;
    let oldNo = 1;
    let newNo = 1;
    while (i < n && j < m) {
        if (a[i] === b[j]) {
            rows.push({ type: 'ctx', text: a[i], oldNo: oldNo++, newNo: newNo++ });
            i++;
            j++;
        } else if (dp[i + 1][j] >= dp[i][j + 1]) {
            rows.push({ type: 'del', text: a[i], oldNo: oldNo++, newNo: null });
            i++;
        } else {
            rows.push({ type: 'add', text: b[j], oldNo: null, newNo: newNo++ });
            j++;
        }
    }
    while (i < n) rows.push({ type: 'del', text: a[i++], oldNo: oldNo++, newNo: null });
    while (j < m) rows.push({ type: 'add', text: b[j++], oldNo: null, newNo: newNo++ });
    return rows;
}

/**
 * Serialize diff rows into a minimal unified-patch text (single hunk, no file
 * headers — the Edit tool input doesn't reliably carry both paths). Used by
 * DiffView's copy button (B-101) so what you copy is a real patch, not a
 * rendering.
 */
export function unifiedPatchText(rows: DiffRow[]): string {
    if (rows.length === 0) return '';
    const oldCount = rows.filter((r) => r.type !== 'add').length;
    const newCount = rows.filter((r) => r.type !== 'del').length;
    const body = rows
        .map((r) => (r.type === 'add' ? '+' : r.type === 'del' ? '-' : ' ') + r.text)
        .join('\n');
    return `@@ -1,${oldCount} +1,${newCount} @@\n${body}`;
}

export function diffStats(rows: DiffRow[]): { added: number; removed: number } {
    let added = 0;
    let removed = 0;
    for (const r of rows) {
        if (r.type === 'add') added++;
        else if (r.type === 'del') removed++;
    }
    return { added, removed };
}
