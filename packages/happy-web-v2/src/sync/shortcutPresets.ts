/**
 * shortcutPresets — pure logic for the unified shortcuts list (B-052).
 *
 * One synced list (settings.promptPresets) serves both the chat composer and
 * the web terminal. Every entry inserts its text without Enter; entries with
 * `run: true` additionally auto-execute (paste + Enter) when picked from the
 * TERMINAL menu — the chat composer always inserts, run or not.
 *
 * This module also owns the one-time client-side migration of the legacy
 * settings.terminalCommands list ({id,title,command}) into promptPresets.
 *
 * BEHAVIOR IS PRESERVED, NOT UPGRADED: the legacy terminal menu pasted
 * without Enter (runCommand never auto-executed), so migrated entries carry
 * NO run flag — picking one still just inserts. `run` is a new opt-in the
 * user turns on per entry; silently arming auto-execute on commands written
 * under paste-only semantics would turn a merge of two identical features
 * into an irreversible surprise (the entry could be `rm -rf …`).
 *
 * Design constraints:
 *
 *   - IDEMPOTENT: an entry is only added if no existing preset has the same
 *     text. Running the migration any number of times, on any number of
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
 * Convert legacy terminalCommands into plain (insert-only) promptPresets.
 *
 * Returns the settings delta to save ({ promptPresets, terminalCommands: [] })
 * or null when there is nothing to migrate (legacy list empty/absent) — the
 * caller must not write anything in that case, otherwise every load would
 * push a redundant settings sync.
 *
 * Dedup key is the command TEXT among ALL existing presets (ids are freshly
 * generated, so they can never match across devices). Text-only matching is
 * also what the user asked for: two entries with the same text ARE the
 * duplicate this merge exists to remove, whatever their run flag says.
 * Whitespace-only commands are junk and are dropped rather than converted;
 * the migration still clears the legacy list in that case.
 */
export function migrateTerminalCommands(
    presets: readonly PromptPreset[] | null | undefined,
    commands: readonly LegacyTerminalCommand[] | null | undefined,
    genId: () => string = defaultGenId,
): { promptPresets: PromptPreset[]; terminalCommands: LegacyTerminalCommand[] } | null {
    if (!commands || commands.length === 0) return null;

    const existing = presets ?? [];
    const seenTexts = new Set(existing.map((p) => p.text));

    const next = [...existing];
    for (const c of commands) {
        const text = c.command;
        if (text.trim().length === 0) continue; // junk entry — drop
        if (seenTexts.has(text)) continue; // already migrated, or a duplicate of an existing preset
        seenTexts.add(text); // also dedupes within the batch itself
        next.push({ id: genId(), title: c.title, text });
    }

    return { promptPresets: next, terminalCommands: [] };
}
