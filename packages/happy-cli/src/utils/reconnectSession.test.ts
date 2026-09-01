import { describe, expect, it } from 'vitest';
import { applyServerSnapshot, mergeReconnectMetadata, processIdentityFields, withoutServerSnapshot } from './reconnectSession';
import type { Metadata, Session } from '@/api/types';

const base: Metadata = { path: '/p', host: 'h', homeDir: '/home', happyHomeDir: '/h/.happy', happyLibDir: '/lib', happyToolsDir: '/tools' };

describe('B-265 reconnect metadata merge', () => {
    it('keeps server conversation fields and takes identity from the local process', () => {
        const server: Metadata = { ...base, summary: { text: 'Fix bug', updatedAt: 1 }, tags: ['assistant'], claudeSessionId: 'c-1', hostPid: 111, version: '0.2.80', capabilities: ['old'], lifecycleState: 'archived', archivedBy: 'cli', archiveReason: 'killed', name: 'n', board: { taskId: 't', analyzedAt: 1 } };
        const local: Metadata = { ...base, hostPid: 222, version: '0.2.92', capabilities: ['claude-steer-v1'], startedBy: 'daemon', startedFromDaemon: true, permissionMode: 'default' };
        const merged = mergeReconnectMetadata(server, local, 5000);
        expect(merged).toMatchObject({
            summary: { text: 'Fix bug', updatedAt: 1 }, tags: ['assistant'], claudeSessionId: 'c-1', name: 'n', board: { taskId: 't', analyzedAt: 1 },
            hostPid: 222, version: '0.2.92', capabilities: ['claude-steer-v1'], startedBy: 'daemon', startedFromDaemon: true, permissionMode: 'default',
            lifecycleState: 'running', lifecycleStateSince: 5000,
        });
        expect(merged.archivedBy).toBeUndefined();
        expect(merged.archiveReason).toBeUndefined();
    });
    it('does not copy identity keys the local process left undefined (codex builds fewer)', () => {
        const server: Metadata = { ...base, attachmentKinds: ['image/png'], queueCancellation: true, capabilities: ['x'] };
        const local: Metadata = { ...base, hostPid: 1 };
        expect(processIdentityFields(local)).toEqual({ hostPid: 1, host: 'h', homeDir: '/home', happyHomeDir: '/h/.happy', happyLibDir: '/lib', happyToolsDir: '/tools' });
        const merged = mergeReconnectMetadata(server, local, 1);
        expect(merged.attachmentKinds).toEqual(['image/png']);
        expect(merged.queueCancellation).toBe(true);
        expect(merged.capabilities).toEqual(['x']);
        expect('attachmentKinds' in processIdentityFields(local)).toBe(false);
    });
});

describe('B-265 server snapshot seeding', () => {
    const response: Session = { id: 's', seq: 3, encryptionKey: new Uint8Array(2), encryptionVariant: 'legacy', metadata: base, metadataVersion: 7, agentState: null, agentStateVersion: 2 };
    it('takes seq, metadata and versions from the server, keeps encryption', () => {
        const seeded = applyServerSnapshot(response, { seq: 120, metadata: { ...base, summary: { text: 's', updatedAt: 1 } }, metadataVersion: 40, agentState: { controlledByUser: false }, agentStateVersion: 9 });
        expect(seeded).toMatchObject({ id: 's', seq: 120, metadataVersion: 40, agentStateVersion: 9, encryptionVariant: 'legacy' });
        expect(seeded.metadata.summary?.text).toBe('s');
        expect(seeded.encryptionKey).toBe(response.encryptionKey);
    });
    it('without a snapshot the env versions are zeroed so the first write mismatches and pulls the server copy', () => {
        expect(withoutServerSnapshot(response)).toMatchObject({ seq: 3, metadataVersion: 0, agentStateVersion: 0 });
    });
});
