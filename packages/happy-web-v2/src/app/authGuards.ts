/**
 * B-490: wire the auth-failure latch (auth/authLatch.ts) into the running app.
 * Imported by AppRoot only — the anonymous PublicRoot never loads it.
 */
import axios from 'axios';
import {
    installAxiosAuthGuard,
    installFetchAuthGuard,
    subscribeAuthLatch,
    tripAuthLatch,
    type AuthGuardDeps,
} from '@/auth/authLatch';
import { AUTH_CREDENTIALS_KEY, isCredentialsRemovedEvent } from '@/auth/authExpiry';
import { getServerUrl } from '@/sync/serverConfig';
import { apiSocket } from '@/sync/apiSocket';


function currentToken(): string | null {
    try {
        const raw = localStorage.getItem(AUTH_CREDENTIALS_KEY);
        if (!raw) return null;
        const token = (JSON.parse(raw) as { token?: unknown }).token;
        return typeof token === 'string' ? token : null;
    } catch {
        return null;
    }
}

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
