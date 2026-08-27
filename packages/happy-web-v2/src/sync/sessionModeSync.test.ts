import { describe, expect, it } from 'vitest';
import type { Message } from './typesMessage';
import type { NormalizedMessage } from './typesRaw';
import { resolveIncomingPermissionMode } from './sessionModeSync';

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
