import { describe, expect, it } from 'vitest';
import { applyHibernationReplay, applyReconnectReplay, applyServerSnapshot, exitCursorStamp, mergeReconnectMetadata, processIdentityFields, withoutServerSnapshot } from './reconnectSession';
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

describe('B-587 waking a hibernated session', () => {
    const stamp = { at: 1, seq: 40, idleMs: 3_600_000, v: 1 as const };
    const session = (seq: number, metadata: Metadata): Session => ({
        id: 's', seq, encryptionKey: new Uint8Array(32), encryptionVariant: 'dataKey',
        metadata, metadataVersion: 3, agentState: null, agentStateVersion: 1,
    } as Session);

    it('the reconnect merge drops the hibernation stamp (awake again) — and JSON drops the key', () => {
        const merged = mergeReconnectMetadata({ ...base, hibernation: stamp, keepAwake: true }, { ...base, hostPid: 2 }, 9);
        expect(merged.hibernation).toBeUndefined();
        expect('hibernation' in JSON.parse(JSON.stringify(merged))).toBe(false);
        expect(merged.keepAwake).toBe(true); // user choice survives the wake
    });

    it('records stored after the stamp are replayed: cursor moves back to the stamp', () => {
        const { response, replaying } = applyHibernationReplay(session(45, { ...base, hibernation: stamp }));
        expect(replaying).toBe(true);
        expect(response.seq).toBe(40);
    });

    it('nothing arrived (or no stamp, or a corrupt one ahead of the server) → keep the server cursor', () => {
        expect(applyHibernationReplay(session(40, { ...base, hibernation: stamp }))).toMatchObject({ replaying: false, response: { seq: 40 } });
        expect(applyHibernationReplay(session(45, base))).toMatchObject({ replaying: false, response: { seq: 45 } });
        expect(applyHibernationReplay(session(30, { ...base, hibernation: stamp }))).toMatchObject({ replaying: false, response: { seq: 30 } });
        expect(applyHibernationReplay(session(45, { ...base, hibernation: { at: 1 } } as unknown as Metadata))).toMatchObject({ replaying: false });
    });
});

describe('B-679 resuming after an offline exit', () => {
    const session = (seq: number, metadata: Metadata): Session => ({
        id: 's', seq, encryptionKey: new Uint8Array(32), encryptionVariant: 'dataKey',
        metadata, metadataVersion: 3, agentState: null, agentStateVersion: 1,
    } as Session);
    const cursor = exitCursorStamp(21, 5);

    it('input stored after the exit cursor is replayed: the seeded cursor moves back to the stamp (QA repro: seq=21 skipped the message sent offline)', () => {
        const { response, replay } = applyReconnectReplay(session(22, { ...base, exitCursor: cursor }));
        expect(replay).toEqual({ source: 'offline-exit', seq: 21 });
        expect(response.seq).toBe(21);
    });

    it('nothing arrived / no stamp / corrupt or ahead → keep the server cursor', () => {
        expect(applyReconnectReplay(session(21, { ...base, exitCursor: cursor }))).toMatchObject({ replay: null, response: { seq: 21 } });
        expect(applyReconnectReplay(session(22, base))).toMatchObject({ replay: null, response: { seq: 22 } });
        expect(applyReconnectReplay(session(22, { ...base, exitCursor: { at: 1, seq: -1 } } as unknown as Metadata))).toMatchObject({ replay: null });
        expect(applyReconnectReplay(session(22, { ...base, exitCursor: { at: 1 } } as unknown as Metadata))).toMatchObject({ replay: null });
    });

    it('a hibernation stamp wins (same replay, but the B-332 scan is skipped for it)', () => {
        const hibernation = { at: 1, seq: 18, idleMs: 1, v: 1 as const };
        expect(applyReconnectReplay(session(22, { ...base, hibernation, exitCursor: cursor })).replay).toEqual({ source: 'hibernation', seq: 18 });
    });

    it('the reconnect merge clears the previous wrapper\'s exit cursor', () => {
        const merged = mergeReconnectMetadata({ ...base, exitCursor: cursor }, { ...base, hostPid: 2 }, 9);
        expect('exitCursor' in JSON.parse(JSON.stringify(merged))).toBe(false);
    });
});
