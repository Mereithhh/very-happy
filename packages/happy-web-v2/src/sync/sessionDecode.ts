/**
 * sessionDecode — the ONE path from server session rows (encrypted metadata /
 * agentState + optional per-session data key) to store-ready sessions.
 *
 * Shared by `fetchSessions` (/v1/sessions) and the `new-session` socket update
 * (B-512), so a session that lands directly from the update is decoded exactly
 * the way the next refetch will decode it.
 *
 * Resilience (mirrors fetchMachines): ONE row with malformed crypto material
 * (bad base64 metadata/key, foreign key format) must not reject the whole
 * batch — InvalidateSync would retry forever and session sync would be wedged.
 * Such a row is skipped; the rest are returned.
 */
import type { Encryption } from './encryption/encryption';
import type { AgentState, Metadata } from './storageTypes';

export interface EncryptedSessionRow {
    id: string;
    seq: number;
    metadata: string;
    metadataVersion: number;
    agentState: string | null;
    agentStateVersion: number;
    dataEncryptionKey: string | null;
    active: boolean;
    activeAt: number;
    createdAt: number;
    updatedAt: number;
}

export type DecodedSession<T extends EncryptedSessionRow> = Omit<T, 'metadata' | 'agentState'> & {
    metadata: Metadata | null;
    agentState: AgentState | null;
    thinking: boolean;
    thinkingAt: number;
};

export type SessionCrypto = Pick<Encryption, 'decryptEncryptionKey' | 'initializeSessions' | 'getSessionEncryption'>;

export async function decodeSessionRows<T extends EncryptedSessionRow>(
    encryption: SessionCrypto,
    rows: T[],
): Promise<DecodedSession<T>[]> {
    // Initialize all session encryptions first.
    const sessionKeys = new Map<string, Uint8Array | null>();
    for (const session of rows) {
        if (session.dataEncryptionKey) {
            let decrypted: Uint8Array | null = null;
            try {
                decrypted = await encryption.decryptEncryptionKey(session.dataEncryptionKey);
            } catch (error) {
                console.error(`Failed to decrypt data encryption key for session ${session.id}:`, error);
            }
            if (!decrypted) {
                console.error(`Failed to decrypt data encryption key for session ${session.id}`);
                continue;
            }
            sessionKeys.set(session.id, decrypted);
        } else {
            sessionKeys.set(session.id, null);
        }
    }
    try {
        await encryption.initializeSessions(sessionKeys);
    } catch (error) {
        console.error('Failed to initialize session encryptions:', error);
    }

    const decoded: DecodedSession<T>[] = [];
    for (const session of rows) {
        // Get session encryption (should always exist after initialization)
        const sessionEncryption = encryption.getSessionEncryption(session.id);
        if (!sessionEncryption) {
            console.error(`Session encryption not found for ${session.id} - this should never happen`);
            continue;
        }

        // A throw (malformed base64 from a corrupt row) must only skip THIS
        // session — see resilience note above.
        let metadata: Metadata | null;
        let agentState: AgentState | null;
        try {
            metadata = await sessionEncryption.decryptMetadata(session.metadataVersion, session.metadata);
            agentState = await sessionEncryption.decryptAgentState(session.agentStateVersion, session.agentState);
        } catch (error) {
            console.error(`Failed to decrypt session ${session.id} - skipping`, error);
            continue;
        }

        decoded.push({
            ...session,
            thinking: false,
            thinkingAt: 0,
            metadata,
            agentState,
        });
    }
    return decoded;
}
