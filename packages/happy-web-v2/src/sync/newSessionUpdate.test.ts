/**
 * B-512 (web item 5): a `new-session` update lands the session in the store
 * directly (no /v1/sessions round trip), an old server's thin update still
 * falls back to the refetch, deleted sessions stay deleted, and a stale
 * snapshot never rolls back versioned metadata / agentState.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { installBrowserTestGlobals } from '@/testing/browserTestGlobals';
import { ApiUpdateContainerSchema, ApiUpdateNewSessionSchema, type ApiUpdateNewSession } from './apiTypes';
import type { SessionCrypto } from './sessionDecode';

let storage: typeof import('./storage').storage;
let isSessionDeleted: typeof import('./storage').isSessionDeleted;
let applyNewSessionUpdate: typeof import('./newSessionUpdate').applyNewSessionUpdate;

beforeAll(async () => {
    installBrowserTestGlobals();
    ({ storage, isSessionDeleted } = await import('./storage'));
    ({ applyNewSessionUpdate } = await import('./newSessionUpdate'));
});

const NOW = 1_700_000_000_000;
const metadataV1 = { machineId: 'm1', path: '/repo', flavor: 'claude' };

// Mirrors happy-server buildNewSessionUpdate() body (eventRouter.ts).
function fullBody(overrides: Partial<ApiUpdateNewSession> = {}): ApiUpdateNewSession {
    return {
        t: 'new-session',
        id: 's-new',
        seq: 0,
        metadata: JSON.stringify(metadataV1),
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 0,
        dataEncryptionKey: 'a2V5',
        active: true,
        activeAt: NOW,
        createdAt: NOW,
        updatedAt: NOW,
        ...overrides,
    };
}
const thinBody: ApiUpdateNewSession = { t: 'new-session', id: 's-new', createdAt: NOW, updatedAt: NOW };

/** Plaintext "encryption": metadata/agentState are JSON; a key of 'bad' fails. */
function fakeCrypto(onDecrypt?: () => void) {
    const initialized = new Set<string>();
    const crypto = {
        decryptEncryptionKey: vi.fn(async (key: string) => (key === 'bad' ? null : new Uint8Array([1, 2, 3]))),
        initializeSessions: vi.fn(async (keys: Map<string, Uint8Array | null>) => {
            for (const id of keys.keys()) initialized.add(id);
        }),
        getSessionEncryption: (id: string) => (initialized.has(id) ? {
            decryptMetadata: async (_v: number, value: string) => { onDecrypt?.(); return JSON.parse(value); },
            decryptAgentState: async (_v: number, value: string | null | undefined) => (value ? JSON.parse(value) : {}),
        } : null),
    };
    return crypto as typeof crypto & SessionCrypto;
}

function deps(crypto: SessionCrypto) {
    return {
        encryption: crypto,
        getSession: (id: string) => storage.getState().sessions[id],
        isDeleted: isSessionDeleted,
        applySessions: (sessions: Parameters<ReturnType<typeof storage.getState>['applySessions']>[0]) => storage.getState().applySessions(sessions),
    };
}

describe('ApiUpdateNewSessionSchema (B-512)', () => {
    it('keeps the full server row instead of stripping it', () => {
        const parsed = ApiUpdateNewSessionSchema.parse(fullBody());
        expect(parsed).toMatchObject({ seq: 0, metadataVersion: 1, dataEncryptionKey: 'a2V5', active: true, activeAt: NOW });
        const container = ApiUpdateContainerSchema.parse({ id: 'u1', seq: 7, createdAt: NOW, body: fullBody() });
        expect(container.body).toMatchObject({ t: 'new-session', metadata: JSON.stringify(metadataV1) });
    });

    it('still accepts an old server\'s thin update (and null key / agentState)', () => {
        expect(ApiUpdateContainerSchema.safeParse({ id: 'u1', seq: 7, createdAt: NOW, body: thinBody }).success).toBe(true);
        expect(ApiUpdateNewSessionSchema.safeParse(fullBody({ dataEncryptionKey: null, agentState: null })).success).toBe(true);
    });
});

describe('applyNewSessionUpdate (B-512)', () => {
    beforeEach(() => {
        storage.setState({ sessions: {}, unreadSessionIds: new Set(), currentViewingSessionId: null } as never);
    });

    it('puts the session in the store from the update alone — no /v1/sessions fetch', async () => {
        const fetchSpy = vi.fn();
        vi.stubGlobal('fetch', fetchSpy);
        const crypto = fakeCrypto();
        expect(await applyNewSessionUpdate(fullBody(), deps(crypto))).toBe(true);
        const session = storage.getState().sessions['s-new'];
        expect(session).toMatchObject({ id: 's-new', metadata: metadataV1, metadataVersion: 1, active: true, presence: 'online', thinking: false });
        expect(crypto.initializeSessions).toHaveBeenCalledOnce();
        expect(fetchSpy).not.toHaveBeenCalled();
        vi.unstubAllGlobals();
    });

    it('an old server\'s thin update applies nothing (caller falls back to the refetch)', async () => {
        const crypto = fakeCrypto();
        expect(await applyNewSessionUpdate(thinBody, deps(crypto))).toBe(false);
        expect(storage.getState().sessions['s-new']).toBeUndefined();
        expect(crypto.initializeSessions).not.toHaveBeenCalled();
    });

    it('an undecodable key applies nothing instead of throwing', async () => {
        expect(await applyNewSessionUpdate(fullBody({ dataEncryptionKey: 'bad' }), deps(fakeCrypto()))).toBe(false);
        expect(storage.getState().sessions['s-new']).toBeUndefined();
    });

    it('respects the delete tombstone, including a delete that lands during decryption', async () => {
        storage.getState().deleteSession('s-dead');
        expect(await applyNewSessionUpdate(fullBody({ id: 's-dead' }), deps(fakeCrypto()))).toBe(false);
        expect(storage.getState().sessions['s-dead']).toBeUndefined();

        const racing = fakeCrypto(() => storage.getState().deleteSession('s-race'));
        expect(await applyNewSessionUpdate(fullBody({ id: 's-race' }), deps(racing))).toBe(false);
        expect(storage.getState().sessions['s-race']).toBeUndefined();
    });

    it('does not roll back a session a newer update already put in the store', async () => {
        const newer = { ...metadataV1, summary: { text: 'Renamed', updatedAt: NOW + 5 } };
        storage.getState().applySessions([{
            id: 's-new', seq: 4, createdAt: NOW, updatedAt: NOW + 5, active: true, activeAt: NOW + 5,
            metadata: newer, metadataVersion: 3, agentState: { controlledByUser: false }, agentStateVersion: 2,
            thinking: true, thinkingAt: NOW + 5, archivedAt: null, draft: 'half-typed',
        } as never]);
        expect(await applyNewSessionUpdate(fullBody(), deps(fakeCrypto()))).toBe(true);
        const session = storage.getState().sessions['s-new'];
        expect(session.metadata).toEqual(newer);
        expect(session.metadataVersion).toBe(3);
        expect(session.agentStateVersion).toBe(2);
        expect(session.thinking).toBe(true);
        expect(session.archivedAt).toBeNull();
        expect(session.draft).toBe('half-typed');
    });
});

describe('applySessions version guard (B-512)', () => {
    const base = {
        id: 's1', seq: 1, createdAt: NOW, updatedAt: NOW, active: true, activeAt: NOW,
        agentState: null, thinking: false, thinkingAt: 0,
    };
    beforeEach(() => {
        storage.setState({ sessions: {}, unreadSessionIds: new Set(), currentViewingSessionId: null } as never);
    });

    it('a stale refetch keeps newer metadata/agentState but takes its other fields', () => {
        storage.getState().applySessions([{ ...base, metadata: { ...metadataV1, summary: { text: 'New title', updatedAt: 2 } }, metadataVersion: 5, agentState: { requests: {} }, agentStateVersion: 4 } as never]);
        storage.getState().applySessions([{ ...base, updatedAt: NOW + 10, active: false, activeAt: NOW + 10, metadata: metadataV1, metadataVersion: 2, agentState: null, agentStateVersion: 1 } as never]);
        const s = storage.getState().sessions.s1;
        expect(s.metadata?.summary?.text).toBe('New title');
        expect(s.metadataVersion).toBe(5);
        expect(s.agentState).toEqual({ requests: {} });
        expect(s.agentStateVersion).toBe(4);
        expect(s.updatedAt).toBe(NOW + 10);
        expect(s.active).toBe(false);
    });

    it('an equal or newer version still replaces, each pair independently', () => {
        storage.getState().applySessions([{ ...base, metadata: metadataV1, metadataVersion: 2, agentStateVersion: 5 } as never]);
        storage.getState().applySessions([{ ...base, metadata: { ...metadataV1, path: '/moved' }, metadataVersion: 3, agentState: null, agentStateVersion: 1 } as never]);
        const s = storage.getState().sessions.s1;
        expect(s.metadata?.path).toBe('/moved');
        expect(s.metadataVersion).toBe(3);
        expect(s.agentStateVersion).toBe(5);
    });
});

describe('sync wiring (B-512)', () => {
    const source = readFileSync(join(process.cwd(), 'src/sync/sync.ts'), 'utf8');

    it('the new-session handler applies directly and keeps the refetch backstop', () => {
        const handler = source.slice(source.indexOf("updateData.body.t === 'new-session'"), source.indexOf("updateData.body.t === 'delete-session'"));
        expect(handler).toContain('await applyNewSessionUpdate(updateData.body, {');
        expect(handler.indexOf('applyNewSessionUpdate(')).toBeLessThan(handler.indexOf('this.sessionsSync.invalidate();'));
    });

    it('fetchSessions decodes through the same shared helper', () => {
        const fetchSessions = source.slice(source.indexOf('private fetchSessions = async'), source.indexOf('public refreshMachines'));
        expect(fetchSessions).toContain('await decodeSessionRows(this.encryption, sessions)');
    });
});
