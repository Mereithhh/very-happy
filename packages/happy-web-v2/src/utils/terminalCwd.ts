/**
 * Pure helpers behind "new terminal in a directory" (B-144) — the sidebar's
 * fourth create option, where the user picks a working directory BEFORE the
 * terminal (and therefore the configured startup command) starts.
 *
 * Kept out of the component so the path arithmetic is unit-testable: the
 * daemon's create path does `tmux new-session -c <cwd>` with the string it is
 * given and does NOT expand a leading `~` (the same trap NewSessionModal has
 * to work around for chat spawns), so every entry point resolves it first.
 *
 * The preset list is the SAME `sessionPathPresets` setting the chat dialog
 * edits — one curated set of working directories serving both.
 */

export interface PathPreset {
    id: string;
    path: string;
    label?: string;
}

/** Trim, and drop a trailing slash (except for a bare root). */
export function normalizeCwdInput(raw: string): string {
    const trimmed = raw.trim();
    if (trimmed.length > 1 && trimmed.endsWith('/')) return trimmed.replace(/\/+$/, '') || '/';
    return trimmed;
}

/**
 * Expand a leading `~` against the machine's reported home dir. Unknown home
 * (old daemon metadata) → returned untouched, so the caller still sends
 * something and the daemon / fs-list decides.
 */
export function expandHomePath(input: string, homeDir?: string): string {
    if (!homeDir) return input;
    const home = homeDir.replace(/\/+$/, '') || '/';
    if (input === '~') return home;
    if (input.startsWith('~/')) return `${home}/${input.slice(2)}`;
    return input;
}

/**
 * Add a preset, or rewrite the one being edited. Returns null when there is
 * nothing to do (empty path, or a duplicate of an existing preset) so the
 * caller can leave state alone.
 */
export function upsertPathPreset(
    list: PathPreset[],
    path: string,
    editingId: string | null,
    newId: () => string,
): { list: PathPreset[]; id: string } | null {
    const p = normalizeCwdInput(path);
    if (!p) return null;
    if (editingId && list.some((x) => x.id === editingId)) {
        return { list: list.map((x) => (x.id === editingId ? { ...x, path: p } : x)), id: editingId };
    }
    if (list.some((x) => x.path === p)) return null;
    const id = newId();
    return { list: [...list, { id, path: p }], id };
}

export function removePathPreset(list: PathPreset[], id: string): PathPreset[] {
    return list.filter((p) => p.id !== id);
}
