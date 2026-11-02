/**
 * B-867 operator tier — client side of the server broker (spec
 * specs/2026-11-session-sharing-operator.md §2, §12).
 *
 *  - calls: `operatorCall` → apiSocket.operatorRPC (`operator-rpc`, session key).
 *  - terminal bytes: `operator-terminal-input|resize|close` up, and
 *    `operator-terminal-output|exit` down, each `data` sealed with the session
 *    key (base64 terminal bytes inside — the same plaintext the owner's web
 *    gets after decrypting an encStream frame with the machine key).
 *  - lifecycle: `operator-revoked` (grantee) and `operator-activity` (owner).
 *
 * Socket listeners are installed lazily on the first subscription through
 * apiSocket's onAny handler map, so sync.ts (a conflict hot zone) stays
 * untouched and an old server simply never emits these events.
 */
import { apiSocket } from './apiSocket';
import { OperatorActivityEventSchema, OperatorRevokedEventSchema } from './sessionShareTypes';
import { parseOperatorExit, parseOperatorOutput, type OperatorTerminalExit, type OperatorTerminalOp, type OperatorTerminalOutput } from './operatorProtocol';
import { sync } from './sync';

export type OperatorActivityEvent = { sessionId: string; granteeAccountId: string; displayName: string; openTerminals: number; lastActivityAt: number | null };
export type OperatorRevokedEvent = { sessionId: string; reason: string };

type Listeners = {
    output: Set<(e: OperatorTerminalOutput) => void>;
    exit: Set<(e: OperatorTerminalExit) => void>;
    revoked: Set<(e: OperatorRevokedEvent) => void>;
    activity: Set<(e: OperatorActivityEvent) => void>;
};

const listeners: Listeners = { output: new Set(), exit: new Set(), revoked: new Set(), activity: new Set() };
let installed = false;

function install(): void {
    if (installed) return;
    installed = true;
    apiSocket.onMessage('operator-terminal-output', (data) => {
        const e = parseOperatorOutput(data);
        if (e) for (const fn of listeners.output) fn(e);
    });
    apiSocket.onMessage('operator-terminal-exit', (data) => {
        const e = parseOperatorExit(data);
        if (e) for (const fn of listeners.exit) fn(e);
    });
    apiSocket.onMessage('operator-revoked', (data) => {
        const parsed = OperatorRevokedEventSchema.safeParse(data);
        if (!parsed.success) return;
        // The server follows with session-share-updated / -revoked, which re-reads
        // the row (share.operate false or gone) so every gate closes; this event
        // only makes the open panes disconnect without waiting for that read.
        for (const fn of listeners.revoked) fn(parsed.data);
    });
    apiSocket.onMessage('operator-activity', (data) => {
        const parsed = OperatorActivityEventSchema.safeParse(data);
        if (parsed.success) for (const fn of listeners.activity) fn(parsed.data);
    });
}

export function onOperatorEvent<K extends keyof Listeners>(kind: K, fn: Listeners[K] extends Set<infer F> ? F : never): () => void {
    install();
    (listeners[kind] as Set<typeof fn>).add(fn);
    return () => { (listeners[kind] as Set<typeof fn>).delete(fn); };
}

/** Install the listeners at app start for surfaces that only read state later. */
export function installOperatorTransport(): void { install(); }

// ---------------------------------------------------------------- calls

export function operatorCall<R = unknown, A = unknown>(sessionId: string, op: OperatorTerminalOp | string, params: A, opts?: { timeoutMs?: number }): Promise<R> {
    return apiSocket.operatorRPC<R, A>(sessionId, op, params, opts);
}

async function seal(sessionId: string, value: unknown): Promise<string | null> {
    const enc = sync.encryption.getSessionEncryption(sessionId);
    return enc ? enc.encryptRaw(value) : null;
}

/** Open a sealed `data` field (terminal bytes as base64). Null when it does not decrypt. */
export async function openOperatorData(sessionId: string, sealed: string): Promise<string | null> {
    const enc = sync.encryption.getSessionEncryption(sessionId);
    if (!enc) return null;
    const out = await enc.decryptRaw(sealed);
    return typeof out === 'string' ? out : null;
}

export async function sendOperatorTerminalInput(sessionId: string, terminalId: string, bytesB64: string): Promise<void> {
    const data = await seal(sessionId, bytesB64);
    if (data) apiSocket.send('operator-terminal-input', { sessionId, terminalId, data });
}

export function sendOperatorTerminalResize(sessionId: string, terminalId: string, cols: number, rows: number): void {
    apiSocket.send('operator-terminal-resize', { sessionId, terminalId, cols, rows });
}

export function sendOperatorTerminalClose(sessionId: string, terminalId: string): void {
    apiSocket.send('operator-terminal-close', { sessionId, terminalId });
}
