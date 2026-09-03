import { db } from '@/storage/db';
import { log } from '@/utils/log';

/**
 * B-297: persist the client's self-reported identity ("cli-daemon/0.2.105") in
 * plaintext so support questions like "is this user still on an old CLI?" are
 * answerable in SQL.
 *
 * Why a new column and not the existing data: the CLI version does travel in
 * `Machine.metadata` / `Session.metadata`, but those are client-encrypted blobs
 * the server never parses. Until now the only server-side copies of the version
 * were a Prometheus label with no account dimension and a log line.
 *
 * What is stored is only the identity string the client sends — no hostname,
 * path, or user content. It is unvalidated input, so it is clamped and stripped
 * of control characters before it reaches a row that ops output will print.
 */

const MAX_CLIENT_LENGTH = 128;

export function normalizeHappyClient(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    const cleaned = raw.replace(/\p{C}/gu, '').trim();
    if (!cleaned) return null;
    return cleaned.slice(0, MAX_CLIENT_LENGTH);
}

type ClientVersionTarget =
    | { kind: 'machine'; machineId: string }
    | { kind: 'session'; sessionId: string };

/**
 * Writes only when the value actually changed (`IS DISTINCT FROM`), so the
 * common case — a daemon reconnecting on the same version — costs one indexed
 * lookup and no row write. Never throws: this is diagnostics, and a failure here
 * must not affect the connection that triggered it.
 */
export async function recordClientVersion(
    userId: string,
    target: ClientVersionTarget,
    happyClient: unknown,
    client: Pick<typeof db, '$executeRaw'> = db,
): Promise<void> {
    const value = normalizeHappyClient(happyClient);
    if (!value) return;
    try {
        if (target.kind === 'machine') {
            await client.$executeRaw`
                UPDATE "Machine"
                SET "lastHappyClient" = ${value}, "lastHappyClientAt" = now()
                WHERE "id" = ${target.machineId}
                  AND "accountId" = ${userId}
                  AND "lastHappyClient" IS DISTINCT FROM ${value}`;
        } else {
            await client.$executeRaw`
                UPDATE "Session"
                SET "lastHappyClient" = ${value}, "lastHappyClientAt" = now()
                WHERE "id" = ${target.sessionId}
                  AND "accountId" = ${userId}
                  AND "lastHappyClient" IS DISTINCT FROM ${value}`;
        }
    } catch (error) {
        log({ module: 'websocket', userId, error }, 'Failed to record client version');
    }
}
