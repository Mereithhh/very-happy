import { TokenStorage } from '@/auth/tokenStorage';
import { clearPersistence } from '@/sync/persistence';
import { clearSyncCacheOnLogout } from '@/sync/cache/syncCache';
import { clearNotificationStateOnLogout } from '@/screens/notifications/logoutCleanup';

export type PurgeReason = 'logout' | 'auth-expired';

/**
 * B-824 §6.2 / B-825: the ONE place this browser forgets an account — the
 * local half of "Sign out" and the confirmed auth-expiry wipe both come here.
 * Order matters: the caches (all `vh-sync-*` databases: message cache,
 * outbox, list snapshot — a blocked delete is recorded as purge-pending) go
 * before the account key, so no cache outlives the key that could decrypt it.
 * Callers that need the server (push unregister, revoke) do that first.
 */
export async function purgeLocalAccountData(reason: PurgeReason): Promise<void> {
    console.log(`[auth] purging local account data (${reason})`);
    // B-813: the local message cache (Owner 10-25: 退出登录时全部清空).
    await clearSyncCacheOnLogout();
    clearPersistence();
    // B-559: app-icon badge, SW count and mark-unread overlay belong to this account.
    clearNotificationStateOnLogout();
    // B-825: the account key — before, only a deliberate sign-out removed it.
    await TokenStorage.removeCredentials();
}
