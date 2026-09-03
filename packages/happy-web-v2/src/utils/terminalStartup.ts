/**
 * B-334 — pure helpers behind "pick the startup command when opening a
 * terminal in a directory".
 *
 * Settings → Terminal keeps ONE global startup command; that stays the
 * default. What this adds is a small MRU list (`terminalStartupPresets`) so a
 * user who alternates between agents (`claude`, `pi`, …) switches with one
 * click instead of editing the global setting every time.
 *
 * Selection is an ID, never a command string, because it has to survive a
 * navigation: the terminal screen re-reads it from the URL (`?cmd=`) after the
 * dialog is gone. Shipping the command itself in the URL would hand a crafted
 * link a shell — exactly the trap `resume` avoids by carrying only a session id
 * (see newTerminalSearch.ts). Resolution therefore looks the id up in the
 * user's OWN saved list and can only ever run something the user saved.
 *
 * Two ids are reserved rather than stored:
 *   'default' — use settings.terminalStartupCommand (also the absent case)
 *   'none'    — run nothing, a bare shell, even when a global command is set
 * An id that resolves to nothing (deleted on another device, hand-edited URL)
 * falls back to 'default': the least-surprise behavior is the one a plain
 * "New terminal" already has.
 */

export interface StartupPreset {
    id: string;
    command: string;
    label?: string;
}

/** Reserved selection ids (never stored in the preset list). */
export const STARTUP_DEFAULT_ID = 'default';
export const STARTUP_NONE_ID = 'none';

/** MRU depth. Small on purpose: this is a switcher, not a shell history. */
export const STARTUP_PRESET_CAP = 12;

/** Trim only — a startup command is a shell line; internal spacing is the user's. */
export function normalizeStartupCommand(raw: string): string {
    return raw.trim();
}

/**
 * Shape guard for the `?cmd=` query. Ids are the same 12-char alphanumerics
 * `newId()` produces, plus the two reserved words; anything else is ignored
 * (→ default), so a hand-written URL can't reach past the saved list.
 */
export function isStartupSelectionId(value: unknown): value is string {
    return typeof value === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(value);
}

/**
 * MRU insert: launching with a command records it. An identical command moves
 * to the front keeping its id (so a chip the user is looking at doesn't jump
 * identity under them); a new one is prepended and the tail is dropped.
 * Returns null when there is nothing to record (empty command).
 */
export function touchStartupPreset(
    list: StartupPreset[],
    command: string,
    newId: () => string,
    cap = STARTUP_PRESET_CAP,
): { list: StartupPreset[]; id: string } | null {
    const cmd = normalizeStartupCommand(command);
    if (!cmd) return null;
    const existing = list.find((p) => p.command === cmd);
    if (existing) {
        return { list: [existing, ...list.filter((p) => p.id !== existing.id)], id: existing.id };
    }
    const id = newId();
    return { list: [{ id, command: cmd }, ...list].slice(0, cap), id };
}

export function removeStartupPreset(list: StartupPreset[], id: string): StartupPreset[] {
    return list.filter((p) => p.id !== id);
}

/**
 * The command an open should actually send, or undefined for "run nothing".
 * `globalCommand` is settings.terminalStartupCommand — an empty string there
 * already means disabled, so it collapses to undefined too.
 */
export function resolveStartupCommand(input: {
    presets: StartupPreset[] | undefined;
    selectionId: string | undefined;
    globalCommand: string | undefined;
}): string | undefined {
    const fallback = normalizeStartupCommand(input.globalCommand ?? '') || undefined;
    const id = input.selectionId;
    if (!id || id === STARTUP_DEFAULT_ID) return fallback;
    if (id === STARTUP_NONE_ID) return undefined;
    const hit = (input.presets ?? []).find((p) => p.id === id);
    return hit ? normalizeStartupCommand(hit.command) || undefined : fallback;
}

/**
 * The chips the dialog renders, in order: the global default (only when one is
 * set — an empty global is indistinguishable from "none"), then the MRU, then
 * "none". `command` is display text; `removable` marks the stored entries.
 */
export interface StartupChoice {
    id: string;
    command: string;
    removable: boolean;
}

export function startupChoices(
    presets: StartupPreset[] | undefined,
    globalCommand: string | undefined,
): StartupChoice[] {
    const global = normalizeStartupCommand(globalCommand ?? '');
    const out: StartupChoice[] = [];
    if (global) out.push({ id: STARTUP_DEFAULT_ID, command: global, removable: false });
    for (const p of presets ?? []) {
        const cmd = normalizeStartupCommand(p.command);
        // The global command is already the first chip; a duplicate MRU entry
        // (the user launched it from the input) would render the same line twice.
        if (!cmd || cmd === global) continue;
        out.push({ id: p.id, command: cmd, removable: true });
    }
    out.push({ id: STARTUP_NONE_ID, command: '', removable: false });
    return out;
}

/**
 * What a launch should send, given the text currently in the dialog's input.
 * The input is the truth: text that matches a chip reuses that chip's id
 * (nothing is stored — picking "no command" twice must not grow the MRU), and
 * text typed by hand is recorded so it becomes a chip next time.
 *
 * `nextPresets` is present only when the list actually changed, so the caller
 * writes settings exactly when there is something new to remember.
 */
export function selectionForLaunch(
    presets: StartupPreset[] | undefined,
    globalCommand: string | undefined,
    typed: string,
    newId: () => string,
): { selectionId?: string; nextPresets?: StartupPreset[] } {
    const cmd = normalizeStartupCommand(typed);
    const match = startupChoices(presets, globalCommand).find((c) => c.command === cmd);
    if (match) return { selectionId: match.id };
    const res = touchStartupPreset(presets ?? [], cmd, newId);
    if (!res) return { selectionId: STARTUP_NONE_ID };
    return { selectionId: res.id, nextPresets: res.list };
}
