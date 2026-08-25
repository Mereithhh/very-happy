/**
 * Account username/password auth (server-trusted, web-only, multi-tenant).
 *
 * The account's opaque `secret` (the key happy uses for encryption/sync) lives
 * server-side; login returns it so any browser with username+password becomes
 * the account — no QR pairing, no client-side crypto. The returned
 * { token, secret } is handed to AuthContext.login for the standard bootstrap
 * (write credentials + start sync), identical to a QR-paired account.
 */

import axios from 'axios';
import { getServerUrl } from '@/sync/serverConfig';
import { getHappyClientId } from '@/sync/apiSocket';
import type { AuthCredentials, TrustedAuthCredentials } from '@/auth/tokenStorage';

export type AccountAuthErrorCode =
    | 'invalid-credentials' // wrong username/password (401)
    | 'username-taken'      // username already used by another account (409)
    | 'reauth-required'     // sensitive credential change needs a fresh login
    | 'rate-limited'        // too many attempts (429)
    | 'network';            // request failed

export class AccountAuthError extends Error {
    code: AccountAuthErrorCode;
    constructor(code: AccountAuthErrorCode, message: string) {
        super(message);
        this.name = 'AccountAuthError';
        this.code = code;
    }
}

/** POST /v1/account/login — returns happy credentials for the matched account. */
export async function loginWithPassword(username: string, password: string): Promise<TrustedAuthCredentials> {
    const serverUrl = getServerUrl();
    try {
        const res = await axios.post<{ token: string; secret: string }>(
            `${serverUrl}/v1/account/login`,
            { username: username.trim().toLowerCase(), password },
            { headers: { 'X-Happy-Client': getHappyClientId() } },
        );
        return { token: res.data.token, secret: res.data.secret };
    } catch (error: any) {
        const status = error?.response?.status;
        if (status === 401) throw new AccountAuthError('invalid-credentials', 'Wrong username or password.');
        if (status === 429) throw new AccountAuthError('rate-limited', 'Too many attempts. Wait a minute and try again.');
        throw new AccountAuthError('network', 'Could not reach the server. Check your connection.');
    }
}

/** Atomically create a password account without consuming capacity via a bare key signup. */
export async function signupWithPassword(
    username: string,
    password: string,
    secret: string,
    inviteCode?: string,
): Promise<TrustedAuthCredentials> {
    const serverUrl = getServerUrl();
    try {
        const response = await axios.post<TrustedAuthCredentials>(
            `${serverUrl}/v1/account/signup/password`,
            {
                username: username.trim().toLowerCase(),
                password,
                secret,
                ...(inviteCode?.trim() ? { inviteCode: inviteCode.trim() } : {}),
            },
            { headers: { 'X-Happy-Client': getHappyClientId() } },
        );
        return { token: response.data.token, secret: response.data.secret };
    } catch (error: any) {
        const status = error?.response?.status;
        const reason = error?.response?.data?.error;
        if (status === 409) throw new AccountAuthError('username-taken', 'That username is taken.');
        if (status === 429) throw new AccountAuthError('rate-limited', 'Too many attempts. Wait a minute and try again.');
        if (status === 403) throw error;
        if (reason === 'invalid_secret') throw new AccountAuthError('network', 'Could not create account. Please try again.');
        throw new AccountAuthError('network', 'Could not reach the server. Check your connection.');
    }
}

/**
 * POST /v1/account/credentials — AUTHENTICATED. Attach username+password to the
 * *current* account and store its secret server-side (so other browsers can log
 * in). `secret` is the account secret the client already holds (credentials.secret),
 * passed through verbatim.
 */
export async function setAccountCredentials(
    username: string,
    password: string,
    secret: string,
    credentials: AuthCredentials,
): Promise<TrustedAuthCredentials | null> {
    const serverUrl = getServerUrl();
    try {
        const response = await axios.post<{ token?: string; secret?: string }>(
            `${serverUrl}/v1/account/credentials`,
            { username: username.trim().toLowerCase(), password, secret },
            {
                headers: {
                    'Authorization': `Bearer ${credentials.token}`,
                    'X-Happy-Client': getHappyClientId(),
                },
            },
        );
        return response.data.token && response.data.secret
            ? { token: response.data.token, secret: response.data.secret }
            : null;
    } catch (error: any) {
        const status = error?.response?.status;
        if (status === 409) throw new AccountAuthError('username-taken', 'That username is taken.');
        if (status === 403 && error?.response?.data?.error === 'reauth_required') {
            throw new AccountAuthError('reauth-required', 'Sign out and sign in again before changing login credentials.');
        }
        throw new AccountAuthError('network', 'Could not save credentials. Please try again.');
    }
}
