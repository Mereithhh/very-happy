import type { Metadata } from '@/sync/storageTypes';

/**
 * B-978: the pi model table the machine's daemon probes (`pi --list-models`)
 * and publishes in `daemonState.piModels`, so a new pi session can offer models
 * before any session exists. Old daemons never write the field → null → the
 * launcher keeps showing only `default`.
 *
 * Trust rule, like agentVersions: only this daemon run's snapshot counts
 * (`daemonPid === pid`), and a snapshot older than 12h is treated as unknown —
 * a machine whose pi was reconfigured would otherwise keep an empty or stale
 * list forever.
 */
export type PiModelTableEntry = { code: string; value: string; thinking: boolean };
export type PiModelTable = { checkedAt: number; models: PiModelTableEntry[] };

const STALE_MS = 12 * 60 * 60 * 1000;

export function readPiModelTable(daemon: unknown, now = Date.now()): PiModelTable | null {
    if (!daemon || typeof daemon !== 'object') return null;
    const state = daemon as { pid?: unknown; piModels?: unknown };
    const raw = state.piModels;
    if (!raw || typeof raw !== 'object') return null;
    const table = raw as { checkedAt?: unknown; daemonPid?: unknown; models?: unknown };
    if (typeof table.checkedAt !== 'number' || !Array.isArray(table.models)) return null;
    if (typeof state.pid === 'number' && table.daemonPid !== state.pid) return null;
    if (now - table.checkedAt > STALE_MS || table.checkedAt > now + 60_000) return null;
    const models = table.models.flatMap((entry) => {
        if (!entry || typeof entry !== 'object') return [];
        const { code, value, thinking } = entry as Record<string, unknown>;
        if (typeof code !== 'string' || !code) return [];
        return [{ code, value: typeof value === 'string' && value ? value : code, thinking: thinking === true }];
    });
    if (models.length === 0) return null;
    return { checkedAt: table.checkedAt, models };
}

/** pi-acp publishes these after session/new; a draft can offer them from the machine table's `thinking` flag. */
export const PI_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const;

/**
 * A catalog shaped like a session's `metadata`, so the launcher and the
 * composer reuse one code path: `getLauncherModelModes` reads `models`, and
 * the effort picker reads `thoughtLevels`. Levels are only offered for a model
 * the machine reported as thinking-capable.
 */
export function piCatalogFromMachine(table: PiModelTable | null, flavor: string | null | undefined): Pick<Metadata, 'flavor' | 'models' | 'thoughtLevels'> | null {
    if (!table) return null;
    return {
        flavor: flavor ?? 'acp',
        models: table.models.map((model) => ({ code: model.code, value: model.value, description: null })),
        thoughtLevels: table.models.some((model) => model.thinking)
            ? PI_THINKING_LEVELS.map((level) => ({ code: level, value: level, description: null }))
            : [],
    };
}

/**
 * A draft's thinking levels for the model it picked: pi keeps one level per
 * session, and a model the machine reported without `thinking` has none — so
 * offering the list there would promise levels pi drops.
 */
export function piDraftThoughtLevels(
    table: PiModelTable | null,
    modelKey: string,
): Array<{ code: string; value: string; description: null }> {
    if (!table) return [];
    const model = table.models.find((entry) => entry.code === modelKey);
    const capable = model ? model.thinking : table.models.some((entry) => entry.thinking);
    return capable ? PI_THINKING_LEVELS.map((level) => ({ code: level, value: level, description: null })) : [];
}
