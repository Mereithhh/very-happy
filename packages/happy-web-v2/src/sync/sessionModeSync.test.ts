import { describe, expect, it } from 'vitest';
import type { Message } from './typesMessage';
import type { NormalizedMessage } from './typesRaw';
import { resolveIncomingPermissionMode, resolveSessionPermissionMode } from './sessionModeSync';

const existing = (id: string, seq: number, mode?: string): Message => ({
    kind: 'user-text', id, localId: null, createdAt: seq * 100, seq, text: id,
    ...(mode ? { meta: { permissionMode: mode } } : {}),
});
const incoming = (id: string, seq: number, mode?: string, role: 'user' | 'agent' = 'user'): NormalizedMessage => ({
    role,
    content: role === 'user' ? { type: 'text', text: id } : [],
    id, localId: null, createdAt: seq * 100, seq, isSidechain: false,
    ...(mode ? { meta: { permissionMode: mode } } : {}),
} as NormalizedMessage);

describe('resolveIncomingPermissionMode', () => {
    it('hydrates from initial history and follows a newer remote user turn', () => {
        expect(resolveIncomingPermissionMode([], [incoming('a', 1, 'default'), incoming('b', 2, 'yolo')])).toBe('yolo');
        expect(resolveIncomingPermissionMode([existing('a', 1, 'default')], [incoming('b', 2, 'yolo')])).toBe('yolo');
    });

    it('ignores older backfill and assistant-only traffic', () => {
        expect(resolveIncomingPermissionMode([existing('b', 2, 'yolo')], [incoming('a', 1, 'default')])).toBeUndefined();
        expect(resolveIncomingPermissionMode([existing('b', 2, 'yolo')], [incoming('c', 3, 'default', 'agent')])).toBeUndefined();
    });

    it('accepts metadata added to the same server message', () => {
        expect(resolveIncomingPermissionMode([existing('a', 1)], [incoming('a', 1, 'yolo')])).toBe('yolo');
    });
});

describe('resolveSessionPermissionMode', () => {
    it('shows the CLI-published mode when the device has no local selection', () => {
        expect(resolveSessionPermissionMode({ publishedMode: 'plan', previousPublishedMode: undefined, localMode: null })).toBe('plan');
    });

    it('lets a published change override a stale device-local selection (cross-device sync)', () => {
        expect(resolveSessionPermissionMode({ publishedMode: 'plan', previousPublishedMode: 'bypassPermissions', localMode: 'bypassPermissions' })).toBe('plan');
        expect(resolveSessionPermissionMode({ publishedMode: 'bypassPermissions', previousPublishedMode: undefined, localMode: 'plan' })).toBe('bypassPermissions');
    });

    it('keeps an optimistic local pick while the published value is unchanged', () => {
        expect(resolveSessionPermissionMode({ publishedMode: 'plan', previousPublishedMode: 'plan', localMode: 'bypassPermissions' })).toBe('bypassPermissions');
    });

    it('falls back to local resolution for CLIs that do not publish a mode', () => {
        expect(resolveSessionPermissionMode({ publishedMode: undefined, previousPublishedMode: undefined, localMode: 'acceptEdits' })).toBe('acceptEdits');
        expect(resolveSessionPermissionMode({ publishedMode: undefined, previousPublishedMode: undefined, localMode: null })).toBeNull();
    });
});
