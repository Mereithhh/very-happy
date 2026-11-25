import type { LatestModelTable } from '@slopus/happy-wire';
import { isLatestModelMode } from '@slopus/happy-wire';
import { getEffortLevelsForModel, type EffortLevel } from '@/components/modelModeOptions';
import type { Metadata } from './storageTypes';
import { resolveLatestForAgent } from './agentDefaults';
import { followEntryModel, followLatestState } from './followLatestDisplay';

/** Lowest → highest; a level this list does not know goes last, in reported order. */
const ORDER = ['none', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const rank = (key: string) => (ORDER.includes(key) ? ORDER.indexOf(key) : ORDER.length);

/**
 * B-975b: the Codex levels Settings offers as the account default, from the
 * composer's source (getEffortLevelsForModel). The default is account-wide, so
 * every machine's newest catalog contributes the levels of the model it would
 * run (its config model for 「本机配置」 / follow-latest); a level one of them
 * cannot run is confirmed before the send (B-975). No catalog → the fallback.
 * The saved level is always listed, so the strip never shows nothing selected.
 * `unsupported`: the model is known and cannot run the saved level.
 */
export function settingsCodexEffort(input: {
    /** Account model: a fixed id, `default` or `latest`. */
    modelMode: string;
    catalogs: readonly Metadata[];
    table: LatestModelTable | null | undefined;
    saved: string | null | undefined;
}): { levels: EffortLevel[]; unsupported: boolean } {
    const follows = isLatestModelMode(input.modelMode);
    const machines = input.catalogs.map((catalog) => {
        const followed = follows ? followEntryModel(followLatestState(resolveLatestForAgent(input.table, 'codex', catalog), true)) : null;
        const machineModel = catalog.configuredModel ?? catalog.defaultModelCode;
        const model = followed ?? (follows || input.modelMode === 'default' ? machineModel ?? 'default' : input.modelMode);
        return { known: model !== 'default', levels: getEffortLevelsForModel('codex', model, catalog) };
    });
    if (machines.length === 0) {
        const model = follows ? 'default' : input.modelMode;
        machines.push({ known: model !== 'default', levels: getEffortLevelsForModel('codex', model) });
    }
    const levels: EffortLevel[] = [];
    for (const level of machines.flatMap((machine) => machine.levels)) {
        if (!levels.some((option) => option.key === level.key)) levels.push(level);
    }
    const missing = !!input.saved && levels.length > 0 && !levels.some((option) => option.key === input.saved);
    if (missing && input.saved) levels.push({ key: input.saved, name: input.saved });
    levels.sort((a, b) => rank(a.key) - rank(b.key));
    return { levels, unsupported: missing && machines.every((machine) => machine.known) };
}
