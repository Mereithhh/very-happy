import { describe, expect, it } from 'vitest';
import { rewriteQueuedPermissionMode } from './queuedPermissionMode';

describe('rewriteQueuedPermissionMode (B-262 B4)', () => {
    const hasher = (mode: { permissionMode?: unknown; model?: string }) => JSON.stringify(mode);

    it('rewrites stale snapshots and their hashes, leaves matching ones alone', () => {
        const queue = [
            { mode: { permissionMode: 'plan', model: 'opus' }, modeHash: hasher({ permissionMode: 'plan', model: 'opus' }) },
            { mode: { permissionMode: 'bypassPermissions', model: 'opus' }, modeHash: hasher({ permissionMode: 'bypassPermissions', model: 'opus' }) },
        ];
        expect(rewriteQueuedPermissionMode(queue, hasher, 'bypassPermissions')).toBe(1);
        expect(queue[0].mode).toEqual({ permissionMode: 'bypassPermissions', model: 'opus' });
        expect(queue[0].modeHash).toBe(hasher({ permissionMode: 'bypassPermissions', model: 'opus' }));
        expect(queue[1].modeHash).toBe(hasher({ permissionMode: 'bypassPermissions', model: 'opus' }));
    });

    it('is a no-op on an empty queue', () => {
        expect(rewriteQueuedPermissionMode([], hasher, 'plan')).toBe(0);
    });
});
