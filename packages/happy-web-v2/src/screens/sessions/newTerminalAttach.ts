/**
 * B-273 — pure helpers for the "attach an existing tmux session" section of
 * NewTerminalModal. No React, no stores: everything the panel decides is a
 * function of (daemon flag, fetched list, selection), so it is unit-tested
 * here and the component stays wiring.
 */
import type { TranslationKey } from '@/text';

export interface UserTmuxSession {
    /** tmux session_id, e.g. `$3` — what the daemon wants back. */
    id: string;
    name: string;
    windows: number;
    attached: boolean;
    activityAt?: number;
    createdAt?: number;
    command?: string;
    cwd?: string;
}

const SESSION_ID_RE = /^\$\d{1,9}$/;

/** Tolerant parse of the `list-tmux-sessions` RPC payload: only well-formed
 *  rows survive (the daemon validates too; this guards a garbled relay). */
export function parseTmuxSessions(raw: unknown): UserTmuxSession[] {
    const list = (raw as any)?.sessions;
    if (!Array.isArray(list)) return [];
    const out: UserTmuxSession[] = [];
    for (const s of list) {
        if (!s || typeof s !== 'object') continue;
        const { id, name, windows, attached, activityAt, createdAt, command, cwd } = s as Record<string, unknown>;
        if (typeof id !== 'string' || !SESSION_ID_RE.test(id)) continue;
        if (typeof name !== 'string' || !name || name.startsWith('vh-')) continue;
        out.push({
            id,
            name,
            windows: typeof windows === 'number' && windows > 0 ? Math.floor(windows) : 1,
            attached: attached === true,
            activityAt: typeof activityAt === 'number' ? activityAt : undefined,
            createdAt: typeof createdAt === 'number' ? createdAt : undefined,
            command: typeof command === 'string' && command ? command : undefined,
            cwd: typeof cwd === 'string' && cwd ? cwd : undefined,
        });
    }
    return out;
}

/** Section shown whenever the daemon supports attach — with a loading line or
 *  an honest empty state, so the entry point is discoverable even when the
 *  machine has no personal tmux sessions yet (B-280). An old daemon (no
 *  capability flag) still renders nothing new at all. */
export function attachSectionVisible(supported: boolean): boolean {
    return supported;
}

/** Which session is selected after clicking `id` (click again = deselect). */
export function toggleAttachSelection(current: string | null, id: string): string | null {
    return current === id ? null : id;
}

/** Compact mono age for a row: `now`/`3m`/`2h`/`5d`; undefined when unknown. */
export function formatSessionAge(at: number | undefined, now: number): string | undefined {
    if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0) return undefined;
    const s = Math.max(0, Math.floor((now - at) / 1000));
    if (s < 60) return 'now';
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    if (h < 48) return `${h}h`;
    return `${Math.floor(h / 24)}d`;
}

/** The primary button's label key depends on whether a session is selected. */
export function primaryLabelKey(attachSelected: boolean): TranslationKey {
    return attachSelected ? 'newTerminalModal.attach' : 'newTerminalModal.create';
}

/** One-time tips card: dismissed hints live in local settings under this key. */
export const TMUX_TIPS_HINT_KEY = 'newTerminalTmux';
export function tipsCardVisible(dismissedHints: Record<string, number> | undefined): boolean {
    return !(dismissedHints && typeof dismissedHints[TMUX_TIPS_HINT_KEY] === 'number');
}
