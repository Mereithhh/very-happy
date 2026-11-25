import type { Server, Socket } from 'socket.io';
import { attentionQueryIncludesPlugin } from '@slopus/happy-wire';
import { allocateUserSeq } from '@/storage/seq';
import { db } from '@/storage/db';
import { log } from '@/utils/log';
import { randomKeyNaked } from '@/utils/randomKeyNaked';

/**
 * B-974 plugin socket fan-out (r5: only to clients that declared `include=plugin`).
 *
 * A Web that knows plugins connects with `auth.include = 'plugin'` (comma list, like the REST query); its
 * user-scoped socket joins `user:<id>:plugin-clients`. Plugin bodies go out as ordinary `update` containers
 * to that room only, so an older Web — whose `update` parser rejects a null `sessionId` — never sees one:
 *   `{ t: 'plugin-install', install }`, `{ t: 'plugin-install', installId, removed: true }`,
 *   `{ t: 'plugin-widget', …PluginWidgetView, widget }` / `{ t: 'plugin-widget', installId, sessionId, removed: true }`,
 *   `{ t: 'attention-item', item }` for plugin and host review cards.
 *
 * Machine side (the daemon hosting the install, r4): `plugin-install-changed { installId }` and
 * `plugin-events-due { installId }` on the machine's own room.
 */

let ioRef: Server | null = null;

export function setPluginIo(io: Server | null): void {
    ioRef = io;
}

export const pluginClientsRoom = (accountId: string) => `user:${accountId}:plugin-clients`;

/** On connect: a user-scoped socket that declared `include=plugin` joins the plugin room. */
export function joinPluginClientsRoom(socket: Socket, accountId: string, connectionType: string): void {
    if (connectionType !== 'user-scoped') return;
    const include = socket.handshake.auth?.include;
    if (typeof include === 'string' && attentionQueryIncludesPlugin(include)) void socket.join(pluginClientsRoom(accountId));
}

async function emit(accountId: string, body: Record<string, unknown>): Promise<void> {
    if (!ioRef) return;
    try {
        const seq = await allocateUserSeq(accountId);
        ioRef.to(pluginClientsRoom(accountId)).emit('update', { id: randomKeyNaked(12), seq, body, createdAt: Date.now() });
    } catch (error) {
        log({ module: 'plugins', level: 'warn', error }, 'plugin update emit failed');
    }
}

export function emitPluginUpdate(accountId: string, body: Record<string, unknown>): void {
    void emit(accountId, body);
}

export function emitPluginAttentionItem(accountId: string, item: unknown): void {
    void emit(accountId, { t: 'attention-item', item });
}

/** Widget body: the wire shape (view fields flat) plus `widget` (the Web store reads either). */
export function emitPluginWidget(accountId: string, view: Record<string, unknown> & { installId: string; sessionId: string }): void {
    void emit(accountId, { t: 'plugin-widget', ...view, widget: view });
}

export function emitPluginWidgetRemoved(accountId: string, installId: string, sessionId: string): void {
    void emit(accountId, { t: 'plugin-widget', installId, sessionId, removed: true });
}

export function emitToMachine(accountId: string, machineId: string, event: 'plugin-install-changed' | 'plugin-events-due', payload: { installId: string }): void {
    try { ioRef?.to(`user:${accountId}:machine:${machineId}`).emit(event, payload); }
    catch (error) { log({ module: 'plugins', level: 'warn', error }, 'plugin machine emit failed'); }
}

/** A daemon just connected: it re-syncs every install and pulls any event that waited while it was offline. */
export async function notePluginMachineConnected(accountId: string, machineId: string): Promise<void> {
    if (!ioRef) return;
    try {
        const installs = await db.pluginInstall.findMany({ where: { accountId, machineId }, select: { id: true } });
        for (const install of installs) {
            emitToMachine(accountId, machineId, 'plugin-install-changed', { installId: install.id });
            emitToMachine(accountId, machineId, 'plugin-events-due', { installId: install.id });
        }
    } catch (error) {
        log({ module: 'plugins', level: 'warn', error }, 'plugin machine-connect notice failed');
    }
}
