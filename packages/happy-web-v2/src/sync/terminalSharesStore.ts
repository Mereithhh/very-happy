/**
 * B-878 terminal sharing — client state and transport (spec
 * specs/2026-11-share-terminals-and-projects.md §3, §7).
 *
 *  - owner:   grants per terminal, who is watching right now (activity).
 *  - grantee: invitations and active shares; the per-grant stream key.
 *  - stream:  `share-terminal-rpc` (ack) and `share-terminal-input|resize|close`
 *             up, `share-terminal-output|exit|revoked|geometry` down — every
 *             `data` sealed with the grant's own stream key (boxed to my
 *             content key by the server), never the owner's machine key.
 *
 * Socket listeners install lazily through apiSocket's handler map (one handler
 * per event name), so sync.ts / storage.ts (conflict hot zones) stay untouched
 * and an old server simply never emits these events.
 */
import { create } from 'zustand';
import { useEffect } from 'react';
import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import { apiSocket } from './apiSocket';
import { AES256Encryption } from './encryption/encryptor';
import { sync } from './sync';
import type { ShareTarget } from './apiSessionShares';
import { useProjectShares } from './projectSharesStore';
import { projectGrantIdOfShareId } from './projectShareTypes';
import {
    createTerminalGrant,
    listIncomingTerminalShares,
    listTerminalGrants,
    respondToTerminalGrant,
    revokeTerminalGrant,
    updateTerminalGrant,
} from './apiTerminalShares';
import {
    ShareTerminalExitSchema,
    ShareTerminalGeometrySchema,
    ShareTerminalOutputSchema,
    ShareTerminalRevokedSchema,
    TerminalShareActivitySchema,
    TerminalShareRpcError,
    TerminalShareUpdatedSchema,
    readTerminalShareAck,
    serialPerKey,
    type IncomingTerminalShare,
    type TerminalGrantView,
    type TerminalShareActivity,
    type TerminalShareExpiry,
    type TerminalShareRole,
} from './terminalShareTypes';

const terminalKey = (machineId: string, terminalId: string) => `${machineId}:${terminalId}`;

export interface TerminalSharesState {
    incoming: IncomingTerminalShare[];
    incomingLoaded: boolean;
    grantsByTerminal: Record<string, TerminalGrantView[]>;
    /** Owner: grantees whose pane is attached right now, by terminal key. */
    watchersByTerminal: Record<string, Record<string, TerminalShareActivity>>;
    refreshIncoming: () => Promise<void>;
    refreshGrants: (machineId: string, terminalId: string) => Promise<void>;
    share: (input: { machineId: string; terminalId: string; title?: string; who: ShareTarget; role: TerminalShareRole; expiresInDays: TerminalShareExpiry; confirmOperator?: true }) => Promise<TerminalGrantView>;
    update: (grant: TerminalGrantView, change: { role?: TerminalShareRole; expiresInDays?: TerminalShareExpiry; confirmOperator?: true }) => Promise<void>;
    revoke: (grant: TerminalGrantView) => Promise<void>;
    respond: (grantId: string, accept: boolean) => Promise<void>;
}

function upsert(list: TerminalGrantView[], next: TerminalGrantView): TerminalGrantView[] {
    const i = list.findIndex((g) => g.id === next.id);
    if (i === -1) return [...list, next];
    const copy = list.slice(); copy[i] = next; return copy;
}

export const useTerminalShares = create<TerminalSharesState>((set, get) => ({
    incoming: [],
    incomingLoaded: false,
    grantsByTerminal: {},
    watchersByTerminal: {},
    refreshIncoming: async () => {
        const incoming = await listIncomingTerminalShares();
        set({ incoming, incomingLoaded: true });
    },
    refreshGrants: async (machineId, terminalId) => {
        const grants = await listTerminalGrants(machineId, terminalId);
        set((s) => ({ grantsByTerminal: { ...s.grantsByTerminal, [terminalKey(machineId, terminalId)]: grants } }));
    },
    share: async (input) => {
        const grant = await createTerminalGrant(input);
        const key = terminalKey(input.machineId, input.terminalId);
        set((s) => ({ grantsByTerminal: { ...s.grantsByTerminal, [key]: upsert(s.grantsByTerminal[key] ?? [], grant) } }));
        return grant;
    },
    update: async (grant, change) => {
        const next = await updateTerminalGrant(grant.id, change);
        const key = terminalKey(grant.machineId, grant.terminalId);
        set((s) => ({ grantsByTerminal: { ...s.grantsByTerminal, [key]: upsert(s.grantsByTerminal[key] ?? [], next) } }));
    },
    revoke: async (grant) => {
        await revokeTerminalGrant(grant.id);
        const key = terminalKey(grant.machineId, grant.terminalId);
        set((s) => ({ grantsByTerminal: { ...s.grantsByTerminal, [key]: (s.grantsByTerminal[key] ?? []).filter((g) => g.id !== grant.id) } }));
    },
    respond: async (grantId, accept) => {
        await respondToTerminalGrant(grantId, accept);
        if (!accept) set((s) => ({ incoming: s.incoming.filter((g) => g.id !== grantId) }));
        await get().refreshIncoming();
    },
}));

// ---------------------------------------------------------------- stream keys

const streamKeys = new Map<string, { boxed: string; enc: AES256Encryption }>();

/** The boxed stream key of a share id: a terminal grant, or (`p:…`) the project grant it derives from. */
async function boxedKeyOf(grantId: string): Promise<string | null> {
    const projectGrantId = projectGrantIdOfShareId(grantId);
    if (projectGrantId) {
        let p = useProjectShares.getState().incoming.find((g) => g.id === projectGrantId);
        if (!p) {
            await useProjectShares.getState().refreshIncoming().catch(() => undefined);
            p = useProjectShares.getState().incoming.find((g) => g.id === projectGrantId);
        }
        return p?.granteeKey ?? null;
    }
    let share = useTerminalShares.getState().incoming.find((g) => g.id === grantId);
    if (!share) {
        await useTerminalShares.getState().refreshIncoming().catch(() => undefined);
        share = useTerminalShares.getState().incoming.find((g) => g.id === grantId);
    }
    return share?.granteeKey ?? null;
}

async function streamKey(grantId: string): Promise<AES256Encryption | null> {
    const granteeKey = await boxedKeyOf(grantId);
    if (!granteeKey) return null;
    const share = { granteeKey };
    const cached = streamKeys.get(grantId);
    // A re-share boxes a fresh key: the cache is keyed by the boxed value too.
    if (cached && cached.boxed === share.granteeKey) return cached.enc;
    const raw = await sync.encryption.decryptEncryptionKey(share.granteeKey);
    if (!raw) return null;
    const enc = new AES256Encryption(raw);
    streamKeys.set(grantId, { boxed: share.granteeKey, enc });
    return enc;
}

async function seal(grantId: string, value: unknown): Promise<string | null> {
    const enc = await streamKey(grantId);
    if (!enc) return null;
    return encodeBase64((await enc.encrypt([value]))[0], 'base64');
}

/** Open a sealed field; null when it does not decrypt. */
export async function openShareData(grantId: string, sealed: string): Promise<unknown | null> {
    const enc = await streamKey(grantId);
    if (!enc) return null;
    try { return (await enc.decrypt([decodeBase64(sealed, 'base64')]))[0] ?? null; } catch { return null; }
}

const RPC_TIMEOUT_MS = 30_000;

/** One broker call. Throws TerminalShareRpcError with a stable code. */
export async function terminalShareCall<R = unknown>(grantId: string, op: 'attach' | 'history' | 'scroll' | 'paste', params: unknown): Promise<R> {
    const sealed = await seal(grantId, params ?? {});
    if (!sealed) throw new TerminalShareRpcError('key_unavailable');
    const sent = await apiSocket.centralEmitWithAck('share-terminal-rpc', { grantId, op, params: sealed }, RPC_TIMEOUT_MS);
    if (!sent.ok) throw new TerminalShareRpcError(sent.reason === 'offline' ? 'machine_offline' : 'server_too_old');
    const read = readTerminalShareAck(sent.ack);
    if (!read.ok) throw new TerminalShareRpcError(read.code);
    const result = await openShareData(grantId, read.result);
    if (result === null) throw new TerminalShareRpcError('rpc_failed');
    return result as R;
}

// B-899: sealing is async (the first call fetches the stream key), so two quick keystrokes could
// overtake each other; each grant's input is sealed and sent strictly in typing order.
const inputQueue = serialPerKey();

export function sendShareTerminalInput(grantId: string, bytesB64: string): Promise<void> {
    return inputQueue(grantId, async () => {
        const data = await seal(grantId, bytesB64);
        if (data) apiSocket.send('share-terminal-input', { grantId, data });
    });
}

export function sendShareTerminalResize(grantId: string, cols: number, rows: number): void {
    apiSocket.send('share-terminal-resize', { grantId, cols, rows });
}

export function sendShareTerminalClose(grantId: string): void {
    apiSocket.send('share-terminal-close', { grantId });
}

// ---------------------------------------------------------------- socket events

type Output = { grantId: string; seq?: number; data: string };
type Exit = { grantId: string; exitCode?: number; reason?: string };
type Revoked = { grantId: string; reason?: string };
type Geometry = { grantId: string; cols: number; rows: number };
type Listeners = { output: Set<(e: Output) => void>; exit: Set<(e: Exit) => void>; revoked: Set<(e: Revoked) => void>; geometry: Set<(e: Geometry) => void> };
const listeners: Listeners = { output: new Set(), exit: new Set(), revoked: new Set(), geometry: new Set() };
let installed = false;

export function installTerminalShareTransport(): void {
    if (installed) return;
    installed = true;
    apiSocket.onMessage('share-terminal-output', (data) => {
        const p = ShareTerminalOutputSchema.safeParse(data);
        if (p.success) for (const fn of listeners.output) fn(p.data);
    });
    apiSocket.onMessage('share-terminal-exit', (data) => {
        const p = ShareTerminalExitSchema.safeParse(data);
        if (p.success) for (const fn of listeners.exit) fn(p.data);
    });
    apiSocket.onMessage('share-terminal-revoked', (data) => {
        const p = ShareTerminalRevokedSchema.safeParse(data);
        if (!p.success) return;
        streamKeys.delete(p.data.grantId);
        for (const fn of listeners.revoked) fn(p.data);
        void useTerminalShares.getState().refreshIncoming().catch(() => undefined);
    });
    apiSocket.onMessage('share-terminal-geometry', (data) => {
        const p = ShareTerminalGeometrySchema.safeParse(data);
        if (p.success) for (const fn of listeners.geometry) fn(p.data);
    });
    apiSocket.onMessage('terminal-share-updated', (data) => {
        if (!TerminalShareUpdatedSchema.safeParse(data).success) return;
        const st = useTerminalShares.getState();
        void st.refreshIncoming().catch(() => undefined);
        // Re-read every terminal whose grant list this tab has open.
        for (const key of Object.keys(st.grantsByTerminal)) {
            const sep = key.indexOf(':');
            void st.refreshGrants(key.slice(0, sep), key.slice(sep + 1)).catch(() => undefined);
        }
    });
    apiSocket.onMessage('terminal-share-activity', (data) => {
        const p = TerminalShareActivitySchema.safeParse(data);
        if (!p.success) return;
        const key = terminalKey(p.data.machineId, p.data.terminalId);
        useTerminalShares.setState((s) => {
            const current = { ...(s.watchersByTerminal[key] ?? {}) };
            if (p.data.watching) current[p.data.grantId] = p.data; else delete current[p.data.grantId];
            return { watchersByTerminal: { ...s.watchersByTerminal, [key]: current } };
        });
    });
}

export function onTerminalShareEvent<K extends keyof Listeners>(kind: K, fn: Listeners[K] extends Set<infer F> ? F : never): () => void {
    installTerminalShareTransport();
    (listeners[kind] as Set<typeof fn>).add(fn);
    return () => { (listeners[kind] as Set<typeof fn>).delete(fn); };
}

/** Grantee surfaces: load the incoming list once per mount and keep it live. */
export function useIncomingTerminalShares(): IncomingTerminalShare[] {
    const incoming = useTerminalShares((s) => s.incoming);
    const loaded = useTerminalShares((s) => s.incomingLoaded);
    const refresh = useTerminalShares((s) => s.refreshIncoming);
    useEffect(() => {
        installTerminalShareTransport();
        if (!loaded) refresh().catch(() => { /* an old server 404s: nothing to show */ });
    }, [loaded, refresh]);
    return incoming;
}

/** Owner: who is watching this terminal right now. */
export function useTerminalWatchers(machineId: string | undefined, terminalId: string | undefined): TerminalShareActivity[] {
    const map = useTerminalShares((s) => (machineId && terminalId ? s.watchersByTerminal[terminalKey(machineId, terminalId)] : undefined));
    useEffect(() => { installTerminalShareTransport(); }, []);
    return map ? Object.values(map) : [];
}
