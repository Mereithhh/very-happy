/**
 * Which Codex threads the import picker must hide on this machine (B-464,
 * revised by B-537).
 *
 * A session's own `codexThreadId` is always tracked. The ORIGINAL an import
 * was forked from (`importedFromCodexThreadId`) is tracked only while the
 * import holds it: the fork succeeded (the session has its own thread) or the
 * wrapper is still running (the fork may be in flight — a second import would
 * race it). `runCodex` stamps `importedFromCodexThreadId` at birth, before the
 * fork, and the daemon's `sessions.json` keeps that birth snapshot: the fork id
 * the wrapper learns later never reaches it (only a restore rewrites the
 * record). Counting every record therefore meant one failed fork hid the
 * original forever, while the empty shell it left had no thread to restore —
 * the user could neither continue nor re-import (B-537).
 *
 * So a record that names an original but no thread of its own is settled by
 * the server's current view of that session: its metadata carries the fork id
 * once the import succeeded, and `active` covers the in-flight window. When the
 * server cannot answer (offline, auth, undecryptable metadata) the original
 * stays hidden — the pre-B-537 behaviour, never a duplicate import.
 */
import { configuration } from '@/configuration';
import { decodeBase64, decrypt } from '@/api/encryption';
import type { PersistedSession } from '@/persistence';

export type CodexImportState =
    /** No such session on this account any more (deleted): nothing holds the original. */
    | { found: false }
    | { found: true; active: boolean; codexThreadId: string | null };

export type CodexImportProbe = (sessionId: string, record: PersistedSession) => Promise<CodexImportState>;

/** Sessions proven to have completed their import → their fork id, per daemon
 *  process. A fork id never goes away, so the answer is final and the server
 *  is asked once. */
const settledImports = new Map<string, string>();

const PROBE_CONCURRENCY = 8;

function idOf(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value.toLowerCase() : null;
}

export async function resolveTrackedCodexThreadIds(
    records: Readonly<Record<string, PersistedSession>>,
    probe: CodexImportProbe,
    options: { settled?: Map<string, string> } = {},
): Promise<string[]> {
    const settled = options.settled ?? settledImports;
    const ids = new Set<string>();
    const pending: Array<{ sessionId: string; record: PersistedSession; source: string }> = [];
    for (const [sessionId, record] of Object.entries(records)) {
        const metadata = (record ?? {}).metadata as (PersistedSession['metadata'] & { importedFromCodexThreadId?: string }) | undefined;
        const own = idOf(metadata?.codexThreadId);
        const source = idOf(metadata?.importedFromCodexThreadId);
        if (own) ids.add(own);
        if (!source) continue;
        const settledFork = settled.get(sessionId);
        if (settledFork) ids.add(settledFork);
        if (own || settledFork) ids.add(source);
        else pending.push({ sessionId, record, source });
    }

    let next = 0;
    const worker = async () => {
        while (next < pending.length) {
            const { sessionId, record, source } = pending[next++];
            let state: CodexImportState;
            try {
                state = await probe(sessionId, record);
            } catch {
                ids.add(source);
                continue;
            }
            if (!state.found) continue;
            if (state.codexThreadId) {
                settled.set(sessionId, state.codexThreadId);
                ids.add(source);
                ids.add(state.codexThreadId);
            } else if (state.active) {
                ids.add(source);
            }
        }
    };
    await Promise.all(Array.from({ length: Math.min(PROBE_CONCURRENCY, pending.length) }, worker));
    return [...ids];
}

/** `GET /v1/sessions/:id`, metadata decrypted with the record's own key.
 *  Throws on anything but a clear answer — the caller then keeps hiding. */
export function serverCodexImportProbe(token: string, timeoutMs = 5_000): CodexImportProbe {
    return async (sessionId, record) => {
        if (typeof record?.encryptionKey !== 'string' || record.encryptionKey.length === 0) {
            throw new Error(`no local key for session ${sessionId}`);
        }
        const response = await fetch(`${configuration.serverUrl}/v1/sessions/${encodeURIComponent(sessionId)}`, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'X-Happy-Client': `cli-daemon/${configuration.currentCliVersion}`,
            },
            signal: AbortSignal.timeout(timeoutMs),
        });
        if (response.status === 404) {
            // Only the route's own answer means "deleted"; a server too old to
            // have the by-id route 404s as well, and that must keep hiding.
            const body = await response.json().catch(() => null) as { error?: unknown } | null;
            if (body?.error === 'Session not found') return { found: false };
            throw new Error('HTTP 404 (no by-id session route)');
        }
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const row = (await response.json() as { session?: { active?: unknown; metadata?: unknown } }).session;
        if (!row || typeof row.metadata !== 'string' || row.metadata.length === 0) {
            throw new Error(`no metadata for session ${sessionId}`);
        }
        const metadata = decrypt(decodeBase64(record.encryptionKey), record.encryptionVariant, decodeBase64(row.metadata)) as { codexThreadId?: unknown } | null;
        if (!metadata || typeof metadata !== 'object') throw new Error(`undecryptable metadata for session ${sessionId}`);
        return {
            found: true,
            active: row.active === true,
            codexThreadId: idOf(metadata.codexThreadId),
        };
    };
}
