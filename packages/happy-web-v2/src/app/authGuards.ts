/**
 * B-490: wire the auth-failure latch (auth/authLatch.ts) into the running app.
 * Imported by AppRoot only — the anonymous PublicRoot never loads it.
 */
import axios from 'axios';
import {
    confirmAuthExpired,
    getUnguardedFetch,
    installAxiosAuthGuard,
    installFetchAuthGuard,
    type AuthExpiryVerdict,
    subscribeAuthLatch,
    tripAuthLatch,
    type AuthGuardDeps,
} from '@/auth/authLatch';
import { isCredentialsRemovedEvent, storedAccountToken } from '@/auth/authExpiry';
import { getServerUrl } from '@/sync/serverConfig';
import { apiSocket } from '@/sync/apiSocket';

const currentToken = storedAccountToken;

function isServerUrl(url: string): boolean {
    try {
        const base = window.location.href;
        return new URL(url, base).origin === new URL(getServerUrl() || '/', base).origin;
    } catch {
        return false;
    }
}

let installed = false;

export function installAuthGuards(): void {
    if (installed || typeof window === 'undefined') return;
    installed = true;
    const deps: AuthGuardDeps = { currentToken, isServerUrl };
    installFetchAuthGuard(window as unknown as { fetch: typeof fetch }, deps);
    installAxiosAuthGuard(axios, deps);
    // The socket reconnects forever on its own (reconnectionAttempts: Infinity);
    // with a dead token that is just another retry loop. connect() refuses
    // while latched, so wake-ups/handovers can't revive it either.
    subscribeAuthLatch(() => apiSocket.disconnect());
    // B-825: another tab signed out or wiped an expired login. This tab's
    // token is gone with it; without the latch its 401s would not count
    // (currentToken() is null) and it would keep the decrypted account on
    // screen and retry forever.
    window.addEventListener('storage', (event) => {
        if (currentToken() === null && isCredentialsRemovedEvent(event)) {
            tripAuthLatch({ status: 401, path: 'signed-out-in-another-tab' });
        }
    });
}

const CONFIRM_TIMEOUT_MS = 5_000;

/**
 * B-825 / B-824 §6.2: ask the server once more, past the latch guard, whether
 * the current token is dead. No token left (another tab signed out) = expired.
 */
export function confirmCurrentTokenExpired(): Promise<AuthExpiryVerdict> {
    const token = currentToken();
    if (!token) return Promise.resolve('expired');
    return confirmAuthExpired(async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), CONFIRM_TIMEOUT_MS);
        try {
            return await getUnguardedFetch()(`${getServerUrl()}/v1/account/profile`, {
                headers: { Authorization: `Bearer ${token}` },
                cache: 'no-store',
                signal: controller.signal,
            });
        } finally {
            clearTimeout(timer);
        }
    });
}
