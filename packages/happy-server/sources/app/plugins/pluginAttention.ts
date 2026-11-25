import type { AttentionItem } from '@slopus/happy-wire';
import { db } from '@/storage/db';
import { AttentionError } from '@/app/attention/rules';
import { pluginsEnabledFor } from './pluginConfig';
import { installBlock, PluginError } from './pluginRules';
import { ownerRespondPlugin, type PluginOwnerRespond } from './pluginDecisions';

/** B-974 bridge from the briefing-board store to plugin cards (kept apart so attention/store.ts stays small). */

/** Installs whose cards the board shows: plugins on for the account, install usable. The host review card shows even while pending. */
export async function visiblePluginInstallIds(accountId: string): Promise<string[]> {
    if (!pluginsEnabledFor(accountId)) return [];
    const rows = await db.pluginInstall.findMany({ where: { accountId }, select: { id: true, state: true, pluginId: true, manifestHash: true, pendingManifestHash: true } });
    return rows.filter(r => installBlock(r) === null || r.state === 'pending' || r.state === 'update_pending').map(r => r.id);
}

/** owner-respond on a plugin card; plugin errors surface as the board's `{ error }` shape. */
export async function ownerRespondPluginItem(accountId: string, id: string, input: PluginOwnerRespond): Promise<{ item: AttentionItem }> {
    try {
        return await ownerRespondPlugin(accountId, id, input);
    } catch (error) {
        if (error instanceof PluginError) throw new AttentionError(error.code, error.status, error.details);
        throw error;
    }
}
