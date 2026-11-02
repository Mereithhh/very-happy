/**
 * B-867: path arithmetic for the operator file panel, confined to the session
 * folder on the client side as well (the daemon and broker are the real
 * guards). POSIX and Windows separators both appear in `metadata.path`.
 */
function sepOf(root: string): '/' | '\\' {
    return root.includes('\\') && !root.includes('/') ? '\\' : '/';
}

function trimEnd(path: string, sep: string): string {
    return path.length > 1 && path.endsWith(sep) ? path.slice(0, -1) : path;
}

/** `dir/name` if `name` is a single plain segment and the result stays inside `root`; else null. */
export function joinWithin(root: string, dir: string, name: string): string | null {
    if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) return null;
    const sep = sepOf(root);
    const base = trimEnd(dir, sep);
    const next = `${base}${base.endsWith(sep) ? '' : sep}${name}`;
    return isWithin(root, next) ? next : null;
}

/** The parent of `dir`, or null when `dir` is already the root (never climbs above it). */
export function parentWithin(root: string, dir: string): string | null {
    const sep = sepOf(root);
    const r = trimEnd(root, sep);
    const d = trimEnd(dir, sep);
    if (d === r || !isWithin(root, d)) return null;
    const cut = d.lastIndexOf(sep);
    const parent = cut <= 0 ? sep : d.slice(0, cut);
    return isWithin(root, parent) ? parent : r;
}

export function isWithin(root: string, path: string): boolean {
    const sep = sepOf(root);
    const r = trimEnd(root, sep);
    const p = trimEnd(path, sep);
    if (p === r) return true;
    return p.startsWith(r.endsWith(sep) ? r : r + sep) && !p.split(sep).includes('..');
}
