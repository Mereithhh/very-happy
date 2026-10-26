import { describe, expect, it, vi } from 'vitest';

// B-824 §6.2 / B-825: the one wipe — every cache before the account key.
const order = vi.hoisted(() => [] as string[]);
vi.mock('@/sync/cache/syncCache', () => ({ clearSyncCacheOnLogout: vi.fn(async () => { order.push('vh-sync-*'); }) }));
vi.mock('@/sync/persistence', () => ({ clearPersistence: vi.fn(() => order.push('persistence')) }));
vi.mock('@/screens/notifications/logoutCleanup', () => ({ clearNotificationStateOnLogout: vi.fn(() => order.push('notifications')) }));
vi.mock('@/auth/tokenStorage', () => ({ TokenStorage: { removeCredentials: vi.fn(async () => { order.push('auth_credentials'); return true; }) } }));

import { purgeLocalAccountData } from './purgeLocalAccountData';

describe('purgeLocalAccountData', () => {
    it('deletes the caches, local state and notifications, and the account key last', async () => {
        await purgeLocalAccountData('auth-expired');
        expect(order).toEqual(['vh-sync-*', 'persistence', 'notifications', 'auth_credentials']);
    });
});
