import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { db } from '@/storage/db';
import { afterTx } from '@/storage/inTx';
import { assertPluginsEnabled, audit, enqueueEvent, loadInstall, requireSessionOnMachine, runPluginTx } from './pluginStore';
import { createWindowLimiter, installBlock, PluginError, requirePlugin, requireUsable, type InstallRow } from './pluginRules';
import { PLUGIN_LIMITS, type PluginWidgetPut } from '@slopus/happy-wire';
import { emitPluginWidget, emitPluginWidgetRemoved } from './pluginSocket';

/** B-974 §5.4 session widgets: ≤ 1 per plugin per session, ≤ 3 plugins per session, own machine's sessions only. */

export const MAX_WIDGETS_PER_SESSION = PLUGIN_LIMITS.widgetsPerSessionShown;
const widgetLimiter = createWindowLimiter(PLUGIN_LIMITS.widgetWritesPerSessionPerMinute, 60_000);

interface WidgetRow { id: string; installId: string; accountId: string; sessionId: string; status: unknown; text: string | null; actions: unknown; panelPath: string | null; version: number; updatedAt: Date }

export function widgetView(w: WidgetRow) {
    return { installId: w.installId, sessionId: w.sessionId, status: w.status, text: w.text, actions: w.actions ?? [], panelPath: w.panelPath, version: w.version, updatedAt: w.updatedAt.getTime() };
}

/** The plugin's own view (`/plugin/v1/sessions/:id/widget`) has no installId. */
function pluginWidgetView(w: WidgetRow) {
    const { installId: _installId, ...rest } = widgetView(w);
    return rest;
}

export async function putWidget(install: InstallRow, input: PluginWidgetPut & { sessionId: string }) {
    const limited = widgetLimiter.take(input.sessionId);
    if (!limited.ok) throw new PluginError('rate_limited', 429, { retryAfterMs: limited.retryAfterMs });
    await requireSessionOnMachine(install.accountId, install.machineId, input.sessionId);
    return runPluginTx(async tx => {
        const existing = await tx.pluginWidget.findUnique({ where: { installId_sessionId: { installId: install.id, sessionId: input.sessionId } } });
        if (input.expectedVersion !== undefined) requirePlugin((existing?.version ?? 0) === input.expectedVersion, 'version_conflict', 409, { currentVersion: existing?.version ?? 0 });
        const content = {
            status: input.status as Prisma.InputJsonValue, text: input.text ?? null,
            actions: input.actions ? input.actions as Prisma.InputJsonValue : Prisma.DbNull, panelPath: input.panelPath ?? null, updatedAt: new Date(),
        };
        let row: WidgetRow;
        if (existing) {
            row = await tx.pluginWidget.update({ where: { id: existing.id }, data: { ...content, version: { increment: 1 } } });
        } else {
            const others = await tx.pluginWidget.count({ where: { sessionId: input.sessionId } });
            requirePlugin(others < MAX_WIDGETS_PER_SESSION, 'limit_exceeded', 422, { limit: MAX_WIDGETS_PER_SESSION });
            row = await tx.pluginWidget.create({ data: { ...content, id: randomUUID(), installId: install.id, accountId: install.accountId, sessionId: input.sessionId } });
        }
        afterTx(tx, () => emitPluginWidget(install.accountId, widgetView(row)));
        return { widget: pluginWidgetView(row) };
    });
}

export async function deleteWidget(install: InstallRow, sessionId: string) {
    return runPluginTx(async tx => {
        const existing = await tx.pluginWidget.findUnique({ where: { installId_sessionId: { installId: install.id, sessionId } } });
        requirePlugin(existing, 'not_found', 404);
        await tx.pluginWidget.delete({ where: { id: existing.id } });
        afterTx(tx, () => emitPluginWidgetRemoved(install.accountId, install.id, sessionId));
        return { removed: true };
    });
}

export async function getWidget(install: InstallRow, sessionId: string) {
    const row = await db.pluginWidget.findUnique({ where: { installId_sessionId: { installId: install.id, sessionId } } });
    requirePlugin(row, 'not_found', 404);
    return { widget: pluginWidgetView(row) };
}

/** r1 GET /v1/plugins/widgets?sessionId=: only usable installs' widgets on live (not archived) sessions. */
export async function listWidgets(accountId: string, sessionId?: string) {
    assertPluginsEnabled(accountId);
    const rows = await db.pluginWidget.findMany({
        where: { accountId, ...(sessionId ? { sessionId } : {}), session: { archivedAt: null } },
        include: { install: true }, orderBy: { createdAt: 'asc' }, take: 500,
    });
    return {
        widgets: rows.filter(r => installBlock(r.install) === null && r.install.grants.includes('session.widget')).map(widgetView),
    };
}

/** POST /v1/plugins/widgets/:installId/:sessionId/action (signed-in person): queue `widget.action` for the plugin. */
export async function widgetAction(accountId: string, installId: string, sessionId: string, actionId: string) {
    assertPluginsEnabled(accountId);
    return runPluginTx(async tx => {
        const install = await loadInstall(tx, accountId, installId);
        requireUsable(install, 'session.widget');
        const widget = await tx.pluginWidget.findUnique({ where: { installId_sessionId: { installId, sessionId } } });
        requirePlugin(widget, 'not_found', 404);
        requirePlugin(((widget.actions as Array<{ id: string }> | null) ?? []).some(a => a.id === actionId), 'unknown_action', 400);
        const eventId = await enqueueEvent(tx, install, 'widget.action', { sessionId, actionId, at: Date.now(), actor: 'owner' });
        await audit(tx, { accountId, installId, actor: 'owner', action: 'widget.action', detail: { sessionId, actionId, eventId } });
        return { eventId };
    });
}
