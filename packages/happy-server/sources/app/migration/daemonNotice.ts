import type { Socket } from 'socket.io';
import type { ServerMigrateNotice } from '@slopus/happy-wire';
import { log } from '@/utils/log';
import { issueMigrationHandoff } from './handoff';
import { resolveMigrationHandoffSecret, resolveMigrationSourceConfig, type MigrationSourceConfig } from './migrationConfig';
import { isMigrationTargeted } from './targeting';

let cached: { source: MigrationSourceConfig | null; secret: string | null } | null = null;

function config(): { source: MigrationSourceConfig | null; secret: string | null } {
    if (!cached) cached = { source: resolveMigrationSourceConfig(), secret: resolveMigrationHandoffSecret() };
    return cached;
}

/** Test seam: forget the cached environment. */
export function resetMigrationConfigCache(): void {
    cached = null;
}

export function buildServerMigrateNotice(source: MigrationSourceConfig, secret: string, accountId: string, machineId: string, nowMs = Date.now()): ServerMigrateNotice {
    return {
        url: source.targetUrl,
        webappUrl: source.targetWebappUrl,
        handoff: issueMigrationHandoff(secret, { kind: 'daemon', accountId, machineId }, nowMs),
        issuedAt: nowMs,
    };
}

/**
 * B-627: on every machine-scoped connect of a targeted account, tell the daemon
 * where to go. Idempotent from the daemon's side (it ignores a notice for the
 * relay it already runs on), so a daemon that failed to move just gets told
 * again next time it connects.
 */
export async function emitServerMigrateIfTargeted(socket: Pick<Socket, 'emit'>, accountId: string, machineId: string): Promise<void> {
    const { source, secret } = config();
    if (!source || !secret) return;
    try {
        if (!(await isMigrationTargeted(source, accountId))) return;
        socket.emit('server-migrate', buildServerMigrateNotice(source, secret, accountId, machineId));
        log({ module: 'migration', accountId, machineId }, 'Sent server-migrate notice to daemon');
    } catch (error) {
        log({ module: 'migration', level: 'warn', error }, 'server-migrate notice failed');
    }
}
