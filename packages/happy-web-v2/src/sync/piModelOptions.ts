import type { ModelMode } from '@/components/modelModeOptions';
import {
    collectRecentCatalogs,
    type LauncherCatalogSource,
    type MachineCatalogSource,
} from './launcherModels';
import { getPiModelModes } from '@/components/modelModeOptions';
import { mapMetadataOptions } from '@/components/modelModeOptions';

/**
 * pi's model list (B-370, B-978).
 *
 * There is no hardcodable registry: a machine's pi has whatever providers it is
 * configured with, and the model ids are pi-acp's `provider/id`. B-978 folds pi
 * into the same source every other agent uses — `collectRecentCatalogs`: the
 * machine's daemon reports its own `pi --list-models` table, and sessions that
 * already ran contribute theirs as the fallback for older daemons. This module
 * only turns those catalogs into picker rows and keeps `default` first.
 *
 * Pure so it can be tested without the store.
 */

/** `default` (don't send a model) first, then each catalog's models, then any saved key that must stay pickable. */
export function withPiDefaults(
    catalogs: ReadonlyArray<{ models?: Array<{ code: string; value: string; description?: string | null }> | null } | null | undefined>,
    keep: readonly (string | null | undefined)[] = [],
): ModelMode[] {
    const out: ModelMode[] = [...getPiModelModes()];
    const seen = new Set(out.map((option) => option.key));
    for (const catalog of catalogs) {
        for (const option of mapMetadataOptions(catalog?.models)) {
            if (seen.has(option.key)) continue;
            seen.add(option.key);
            out.push(option);
        }
    }
    for (const key of keep) {
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push({ key, name: key, description: null });
    }
    return out;
}

/**
 * The account-wide pi list, deduplicated per machine. `machines` carries the
 * daemons' reported tables (see `collectRecentCatalogs`); without them the list
 * is whatever pi sessions published, which is all an old daemon can offer.
 */
export function collectPiModelOptions(
    sessions: readonly LauncherCatalogSource[],
    keep: readonly (string | null | undefined)[] = [],
    machines: readonly MachineCatalogSource[] = [],
): ModelMode[] {
    return withPiDefaults(collectRecentCatalogs(sessions, 'pi', undefined, machines), keep);
}
