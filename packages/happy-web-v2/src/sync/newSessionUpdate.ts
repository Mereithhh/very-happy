/**
 * B-512 (web, item 5): land a `new-session` socket update directly in the
 * store.
 *
 * The server's update has always carried the full session row
 * (happy-server `buildNewSessionUpdate`), but the web only called
 * `sessionsSync.invalidate()` and the session page sat on its loader until a
 * full `GET /v1/sessions` came back. Now the row is decoded with the same
 * `decodeSessionRows` as that fetch and applied immediately; the caller keeps
 * the `invalidate()` as a backstop.
 *
 * Returns whether the session was applied. `false` means "do nothing new":
 * an older server that sends only `{id, createdAt, updatedAt}`, a row whose
 * crypto could not be decoded, or a tombstoned (deleted) session.
 */
import type { ApiUpdateNewSession } from './apiTypes';
import { decodeSessionRows, type EncryptedSessionRow, type SessionCrypto } from './sessionDecode';
import { preserveSessionActivityFromStore } from './sessionSnapshot';
import type { Session } from './storageTypes';

/** The encrypted row carried by the update, or null for an old server. */
export function sessionRowFromNewSessionUpdate(body: ApiUpdateNewSession): EncryptedSessionRow | null {
    if (
        body.seq === undefined
        || body.metadata === undefined
        || body.metadataVersion === undefined
        || body.agentStateVersion === undefined
        || body.dataEncryptionKey === undefined
        || body.active === undefined
        || body.activeAt === undefined
    ) return null;
    return {
        id: body.id,
        seq: body.seq,
        metadata: body.metadata,
        metadataVersion: body.metadataVersion,
        agentState: body.agentState ?? null,
        agentStateVersion: body.agentStateVersion,
        dataEncryptionKey: body.dataEncryptionKey,
        active: body.active,
        activeAt: body.activeAt,
        createdAt: body.createdAt,
        updatedAt: body.updatedAt,
    };
}

type SessionInput = Omit<Session, 'presence'> & { presence?: 'online' | number };

export interface NewSessionUpdateDeps {
    encryption: SessionCrypto;
    getSession: (id: string) => Session | undefined;
    isDeleted: (id: string) => boolean;
    applySessions: (sessions: SessionInput[]) => void;
}

export async function applyNewSessionUpdate(body: ApiUpdateNewSession, deps: NewSessionUpdateDeps): Promise<boolean> {
    if (deps.isDeleted(body.id)) return false;
    const row = sessionRowFromNewSessionUpdate(body);
    if (!row) return false;
    const [decoded] = await decodeSessionRows(deps.encryption, [row]);
    if (!decoded) return false;
    // Decryption is async: a delete may have landed meanwhile. applySessions
    // filters tombstones too; checking here keeps the return value honest.
    if (deps.isDeleted(body.id)) return false;

    // Read the store once, right before the synchronous apply. A session the
    // store already knows (a racing refetch or update-session got there
    // first) keeps its local-only fields and archive state; live activity is
    // preserved like a refetch does, and applySessions' version guard keeps
    // any newer metadata / agentState.
    const existing = deps.getSession(body.id);
    const { dataEncryptionKey: _key, ...fields } = decoded;
    const merged: SessionInput = existing
        ? { ...existing, ...fields }
        : { ...fields };
    deps.applySessions([preserveSessionActivityFromStore(merged, existing)]);
    return true;
}
