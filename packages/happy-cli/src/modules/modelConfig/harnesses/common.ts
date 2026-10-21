export function getPath(obj: unknown, path: string[]): unknown {
    let cur = obj;
    for (const p of path) {
        if (!cur || typeof cur !== 'object' || Array.isArray(cur)) return undefined;
        cur = (cur as Record<string, unknown>)[p];
    }
    return cur;
}

/** Owned key paths whose value differs between two parsed documents (names only, for audit). */
export function changedPaths(before: unknown, after: unknown, paths: string[][]): string[] {
    return paths
        .filter(path => JSON.stringify(getPath(before, path)) !== JSON.stringify(getPath(after, path)))
        .map(path => path.join('.'));
}

export function uniq(values: (string | null | undefined)[]): string[] {
    const out: string[] = [];
    for (const v of values) if (v && !out.includes(v)) out.push(v);
    return out;
}
