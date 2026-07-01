/** Best-effort language id from a file path's extension (for highlighting). */
export function langForPath(path: string | null | undefined): string | null {
    if (!path) return null;
    const base = path.split('/').pop() ?? path;
    if (/^dockerfile$/i.test(base)) return 'docker';
    const ext = base.includes('.') ? base.split('.').pop()!.toLowerCase() : null;
    return ext;
}
