/**
 * shortcutPresets — pure logic for the unified shortcuts list (B-052).
 *
 * One synced list (settings.promptPresets) serves both the chat composer and
 * the web terminal. Every entry inserts its text without Enter; entries with
 * `run: true` additionally auto-execute (paste + Enter) when picked from the
 * TERMINAL menu — the chat composer always inserts, run or not.
 *
 * This module also owns the one-time client-side migration of the legacy
 * settings.terminalCommands list ({id,title,command}, selected = execute)
 * into promptPresets entries with run:true. Design constraints:
 *
 *   - IDEMPOTENT: an entry is only added if no existing run-preset has the
 *     same text. Running the migration any number of times, on any number of
 *     devices, converges on one copy per distinct command text. Two devices
 *     migrating concurrently generate different ids for the same command, but
 *     field-level LWW makes one device's promptPresets array win whole — and
 *     whichever wins contains exactly one copy (the loser's array is not
 *     merged in, so no duplicates can survive).
 *   - Migration is signalled as ONE settings delta: promptPresets gains the
 *     converted entries and terminalCommands becomes [] in the same
 *     field-level update, so a crash between the two can't happen and the
 *     next load sees terminalCommands empty → no-op.
 *   - The legacy field stays in the schema (old bundles still read/write it);
 *     only the UI entry points were removed.
 */

export interface PromptPreset {
    id: string;
    title: string;
    text: string;
    /** true → the terminal menu executes on select (paste + Enter). */
    run?: boolean;
}

export interface LegacyTerminalCommand {
    id: string;
    title: string;
    command: string;
}

/** Classification for menus: does picking this entry in the TERMINAL execute it? */
export function presetRuns(p: Pick<PromptPreset, 'run'>): boolean {
    return p.run === true;
}

function defaultGenId(): string {
    return Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);
}

/**
 * Convert legacy terminalCommands into run:true promptPresets entries.
 *
 * Returns the settings delta to save ({ promptPresets, terminalCommands: [] })
 * or null when there is nothing to migrate (legacy list empty/absent) — the
 * caller must not write anything in that case, otherwise every load would
 * push a redundant settings sync.
 *
 * Dedup key is the command TEXT among existing run-presets (ids are freshly
 * generated, so they can never match across devices). Whitespace-only
 * commands are junk and are dropped rather than converted; the migration
 * still clears the legacy list in that case.
 */
export function migrateTerminalCommands(
    presets: readonly PromptPreset[] | null | undefined,
    commands: readonly LegacyTerminalCommand[] | null | undefined,
    genId: () => string = defaultGenId,
): { promptPresets: PromptPreset[]; terminalCommands: LegacyTerminalCommand[] } | null {
    if (!commands || commands.length === 0) return null;

    const existing = presets ?? [];
    const seenRunTexts = new Set(
        existing.filter(presetRuns).map((p) => p.text),
    );

    const next = [...existing];
    for (const c of commands) {
        const text = c.command;
        if (text.trim().length === 0) continue; // junk entry — drop
        if (seenRunTexts.has(text)) continue; // already migrated (this or another device)
        seenRunTexts.add(text); // also dedupes within the batch itself
        next.push({ id: genId(), title: c.title, text, run: true });
    }

    return { promptPresets: next, terminalCommands: [] };
}
