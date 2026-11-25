import { dispatchDeviceEventPush } from '@/app/push/pushDispatch';
import { db } from '@/storage/db';
import { log } from '@/utils/log';

/**
 * B-974 §5.3 / Q5: a plugin card pushes at most once per key — the `pushedAt IS NULL` claim, which a
 * repost or reopen never clears — and never while the owner muted the plugin or the plugin posted
 * `push: false`. The source label is fixed by the host (「插件 · 名字」); the plugin only supplies the title.
 */
export async function pushPluginItemOnce(row: { id: string; accountId: string; title: string; state: string; pluginInstallId: string }): Promise<boolean> {
    if (row.state !== 'open' && row.state !== 'in_progress') return false;
    try {
        const install = await db.pluginInstall.findUnique({ where: { id: row.pluginInstallId }, select: { muted: true, manifest: true, pluginId: true, state: true } });
        if (!install || install.muted || (install.state !== 'enabled' && install.state !== 'update_pending')) return false;
        const item = await db.attentionItem.findUnique({ where: { id: row.id }, select: { pluginState: true } });
        // `push: false` from the plugin, and the operator's switch, both mean no push.
        if ((item?.pluginState as { push?: boolean } | null)?.push === false) return false;
        const claimed = await db.attentionItem.updateMany({ where: { id: row.id, pushedAt: null }, data: { pushedAt: new Date() } });
        if (claimed.count !== 1) return false;
        const name = (install.manifest as { name?: string } | null)?.name ?? install.pluginId;
        await dispatchDeviceEventPush({
            userId: row.accountId,
            title: `插件 · ${name}`.slice(0, 200),
            body: row.title.slice(0, 500),
            data: { kind: 'attention', itemId: row.id, url: `/board?item=${encodeURIComponent(row.id)}` },
        });
        return true;
    } catch (error) {
        log({ module: 'plugins', level: 'warn', error }, 'plugin push failed');
        return false;
    }
}
