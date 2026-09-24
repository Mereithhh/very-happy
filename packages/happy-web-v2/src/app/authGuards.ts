/**
 * B-490: wire the auth-failure latch (auth/authLatch.ts) into the running app.
 * Imported by AppRoot only — the anonymous PublicRoot never loads it.
 */
import axios from 'axios';
import {
    installAxiosAuthGuard,
    installFetchAuthGuard,
    subscribeAuthLatch,
    type AuthGuardDeps,
} from '@/auth/authLatch';
import { getServerUrl } from '@/sync/serverConfig';
import { apiSocket } from '@/sync/apiSocket';

const AUTH_KEY = 'auth_credentials'; // tokenStorage.ts (web)

function currentToken(): string | null {
    try {
        const raw = localStorage.getItem(AUTH_KEY);
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
}
