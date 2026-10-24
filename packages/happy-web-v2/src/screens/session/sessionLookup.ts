/**
 * B-798 P1-8 — a session page whose id is not in the store. The session list
 * holds only the newest 150 rows, so "not in the store" is not "not found":
 * once the list has loaded, ask the server for that one id; only its 404 says
 * the session does not exist. Before this the page showed 「正在加载消息…」
 * forever, for unknown ids and old sessions alike.
 */
export type SessionLookup = 'idle' | 'checking' | 'missing' | 'failed';
export type SessionGate = 'loading' | 'missing' | 'failed';

/** Ask the server only after the list loaded, for an id still absent, once. */
export function shouldLookUpSession(input: { dataReady: boolean; inStore: boolean; pending: boolean; lookup: SessionLookup }): boolean {
    return input.dataReady && !input.inStore && !input.pending && input.lookup === 'idle';
}

/** What the page shows while the session is absent from the store. */
export function sessionGate(input: { dataReady: boolean; lookup: SessionLookup }): SessionGate {
    if (!input.dataReady) return 'loading';
    if (input.lookup === 'missing') return 'missing';
    if (input.lookup === 'failed') return 'failed';
    return 'loading';
}
