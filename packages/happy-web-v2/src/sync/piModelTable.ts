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
/**
 * `cli`: `pi --list-models` (the whole registry). `models-json`: the daemon
 * could not run that and read models.json instead — only the providers the
 * user configured; pi's built-in providers are missing, and the picker says so.
 */
export type PiModelSource = 'cli' | 'models-json';
export type PiModelTable = { checkedAt: number; source: PiModelSource; models: PiModelTableEntry[] };

const STALE_MS = 12 * 60 * 60 * 1000;

export function readPiModelTable(daemon: unknown, now = Date.now()): PiModelTable | null {
    if (!daemon || typeof daemon !== 'object') return null;
    const state = daemon as { pid?: unknown; piModels?: unknown };
    const raw = state.piModels;
    if (!raw || typeof raw !== 'object') return null;
    const table = raw as { checkedAt?: unknown; daemonPid?: unknown; source?: unknown; models?: unknown };
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
    return { checkedAt: table.checkedAt, source: table.source === 'models-json' ? 'models-json' : 'cli', models };
}

/**
 * The thinking levels pi-acp 0.0.33 accepts (`isThinkingLevel`): one set for
 * every model; pi applies it only to a model that reasons.
 */
export const PI_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const;

/** Marker on a machine-reported catalog (not a session field): which source filled it. */
export type PiMachineCatalog = Pick<Metadata, 'flavor' | 'machineId' | 'models' | 'thoughtLevels'> & { piModelSource: PiModelSource };

/**
 * A catalog shaped like a session's `metadata`, so the launcher reuses the
 * code path of every other agent (`collectRecentCatalogs` →
 * `getLauncherModelModes`). Thinking levels are set only when the table says
 * the machine has a model that reasons — `pi --list-models` reports that per
 * model; without it a draft shows 「默认」 only and the session's own levels
 * apply once it starts, as for dsh.
 */
export function piCatalogFromMachine(table: PiModelTable | null, flavor: string | null | undefined, machineId?: string): PiMachineCatalog | null {
    if (!table) return null;
    return {
        flavor: flavor ?? 'acp',
        ...(machineId ? { machineId } : {}),
        models: table.models.map((model) => ({ code: model.code, value: model.value, description: null })),
        thoughtLevels: table.models.some((model) => model.thinking)
            ? PI_THINKING_LEVELS.map((level) => ({ code: level, value: level, description: null }))
            : [],
        piModelSource: table.source,
        // Per-model flag, read back by piDraftThoughtLevels.
        ...({ piThinking: Object.fromEntries(table.models.map((model) => [model.code, model.thinking])) } as object),
    };
}

/**
 * A draft's thinking levels for the model it picked, from the machine's own
 * table: levels for a model reported as reasoning, none otherwise (and none for
 * `default`, whose model the Web cannot know). A catalog a pi session published
 * carries no per-model flag, so it gives none either — the session's levels
 * show once it starts.
 */
export function piDraftThoughtLevels(
    catalog: unknown,
    modelKey: string,
): Array<{ code: string; value: string; description: null }> {
    const flags = (catalog as { piThinking?: Record<string, boolean> } | null)?.piThinking;
    if (!flags || modelKey === 'default' || flags[modelKey] !== true) return [];
    return PI_THINKING_LEVELS.map((level) => ({ code: level, value: level, description: null }));
}

/** True when the machine's list came from models.json, so pi's built-in providers are missing from it. */
export function isPartialPiCatalog(catalog: unknown): boolean {
    return (catalog as { piModelSource?: unknown } | null)?.piModelSource === 'models-json';
}
