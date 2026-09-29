import { describe, expect, it, vi } from 'vitest';

// B-512 review: the post-webhook half (./runClaudeDeps) fails to load AFTER the
// session row exists and the daemon webhook went out. The wrapper must mark the
// session offline (deactivate — never archive, AGENTS constraint 7) and exit 1.
const { mockApiClientCreate, mockNotify } = vi.hoisted(() => ({
    mockApiClientCreate: vi.fn(),
    mockNotify: vi.fn(async () => ({})),
}));

vi.mock('@/api/api', () => ({ ApiClient: { create: mockApiClientCreate } }));
vi.mock('@/persistence', () => ({ readSettings: vi.fn(async () => ({ machineId: 'machine-1' })) }));
vi.mock('@/utils/sessionLock', () => ({ claimSessionOrExit: vi.fn(async () => {}) }));
vi.mock('@/daemon/controlClient', () => ({ notifyDaemonSessionStarted: mockNotify }));
vi.mock('@/daemon/machineMetadata', () => ({ getInitialMachineMetadata: () => ({}) }));
vi.mock('@/ui/logger', () => ({ logger: { debug: vi.fn(), debugLargeJson: vi.fn(), warn: vi.fn() } }));
vi.mock('@/utils/serverConnectionErrors', () => ({
    connectionState: { setBackend: vi.fn() },
    startOfflineReconnection: vi.fn(),
}));
// A module of the deferred half that cannot be loaded (half-installed tree).
vi.mock('@/claude/loop', () => { throw new Error('Cannot find module loop-XXXX.mjs'); });

import { runClaude } from './runClaude';

describe('runClaude when the deferred modules fail to load (B-512 review)', () => {
    it('deactivates (not archives) the session and exits 1', async () => {
        const sessionClient = { close: vi.fn(async () => {}) };
        const api = {
            getOrCreateMachine: vi.fn(async () => ({})),
            getOrCreateSession: vi.fn(async () => ({
                id: 'happy-session-deps', seq: 0, metadata: {}, metadataVersion: 0,
                agentState: {}, agentStateVersion: 0,
                encryptionKey: new Uint8Array(32), encryptionVariant: 'legacy' as const,
            })),
            sessionSyncClient: vi.fn(() => sessionClient),
            deactivateSession: vi.fn(async () => true),
            archiveSession: vi.fn(async () => true),
        };
        mockApiClientCreate.mockResolvedValue(api);
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
            throw new Error(`process.exit(${code})`);
        }) as never);
        try {
            await expect(runClaude({ token: 't', encryption: { type: 'legacy', secret: new Uint8Array(32) } } as any, {
                startingMode: 'remote', startedBy: 'daemon',
            })).rejects.toThrow('process.exit(1)');
        } finally {
            exitSpy.mockRestore();
        }
        expect(mockNotify).toHaveBeenCalled();
        expect(sessionClient.close).toHaveBeenCalled();
        expect(api.deactivateSession).toHaveBeenCalledWith('happy-session-deps');
        expect(api.archiveSession).not.toHaveBeenCalled();
    });
});
