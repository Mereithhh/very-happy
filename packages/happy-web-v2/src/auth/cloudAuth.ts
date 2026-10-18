import axios from 'axios';
import { getServerUrl } from '@/sync/serverConfig';
import { getHappyClientId } from '@/sync/apiSocket';
import type { AuthCredentials } from './tokenStorage';

export type SignupMode = 'open' | 'invite' | 'closed';

export interface PublicAuthConfig {
    googleClientId?: string;
    /**
     * B-620: present when the server has a generic OIDC issuer configured.
     * B-623: `signupMode` is the policy for first logins through SSO (may differ
     * from `signup.mode`); older servers omit it and fall back to `signup.mode`.
     */
    oidc?: { displayName: string; signupMode?: SignupMode };
    emailOtpEnabled: boolean;
    passwordLoginEnabled: boolean;
    signup: {
        mode: SignupMode;
        maxAccounts: number | null;
        registeredAccounts: number;
        remainingAccounts: number | null;
        atCapacity: boolean;
    };
}

export interface GoogleLoginChallenge {
    nonce: string;
    expiresAt: string;
}

export type CloudAuthErrorCode =
    | 'capacity-reached'
    | 'invite-required'
    | 'signup-closed'
    | 'rate-limited'
    | 'invalid-credential'
    | 'origin-not-allowed'
    | 'invalid-email-code'
    | 'email-delivery-unavailable'
    | 'email-not-configured'
    | 'email-identity-in-use'
    | 'google-identity-in-use'
    | 'google-not-configured'
    | 'reauth-required'
    | 'invalid-account-secret'
    | 'oidc-not-configured'
    | 'oidc-provider-unavailable'
    | 'invalid-handoff'
    | 'invalid-migration-handoff'
    | 'not-targeted'
    | 'network';

export class CloudAuthError extends Error {
    constructor(readonly code: CloudAuthErrorCode) {
        super(code);
        this.name = 'CloudAuthError';
    }
}

export async function loadPublicAuthConfig(): Promise<PublicAuthConfig | null> {
    try {
        const response = await axios.get<Partial<PublicAuthConfig> & Pick<PublicAuthConfig, 'signup'>>(`${getServerUrl()}/v1/auth/config`, {
            headers: { 'X-Happy-Client': getHappyClientId() },
        });
        return {
            ...response.data,
            // Old servers omit these fields. Password remains the compatibility
            // path; Email OTP only appears when the server explicitly advertises it.
            emailOtpEnabled: response.data.emailOtpEnabled === true,
            passwordLoginEnabled: response.data.passwordLoginEnabled !== false,
        };
    } catch {
        // Old server or offline: password login remains the compatibility path.
        return null;
    }
}

export interface EmailLoginChallenge {
    challengeId: string;
    expiresAt: string;
}

export interface AccountLoginMethods {
    email: string | null;
    google: { connected: boolean; email: string | null };
    passwordConfigured: boolean;
}

function authenticatedHeaders(credentials: AuthCredentials) {
    return {
        Authorization: `Bearer ${credentials.token}`,
        'X-Happy-Client': getHappyClientId(),
    };
}

export async function loadAccountLoginMethods(credentials: AuthCredentials): Promise<AccountLoginMethods> {
    const response = await axios.get<AccountLoginMethods>(`${getServerUrl()}/v1/account/identities`, {
        headers: authenticatedHeaders(credentials),
    });
    return response.data;
}

export async function refreshCloudLogin(credentials: AuthCredentials): Promise<AuthCredentials> {
    try {
        const response = await axios.post<AuthCredentials>(
            `${getServerUrl()}/v1/account/login/refresh`,
            { secret: credentials.secret },
            { headers: authenticatedHeaders(credentials) },
        );
        return { token: response.data.token, secret: response.data.secret };
    } catch (error: any) {
        const status = error?.response?.status;
        const reason = error?.response?.data?.error;
        if (reason === 'invalid_secret' || status === 400) throw new CloudAuthError('invalid-account-secret');
        if (status === 429) throw new CloudAuthError('rate-limited');
        throw new CloudAuthError('network');
    }
}

export async function linkEmailIdentity(
    email: string,
    challengeId: string,
    code: string,
    credentials: AuthCredentials,
): Promise<{ success: true; email: string }> {
    try {
        const response = await axios.post<{ success: true; email: string }>(
            `${getServerUrl()}/v1/account/identities/email`,
            {
                email: email.trim().toLowerCase(),
                challengeId,
                code: code.trim(),
                secret: credentials.secret,
            },
            { headers: authenticatedHeaders(credentials) },
        );
        return response.data;
    } catch (error: any) {
        const status = error?.response?.status;
        const reason = error?.response?.data?.error;
        if (reason === 'email_identity_in_use' || status === 409) throw new CloudAuthError('email-identity-in-use');
        if (reason === 'reauth_required' || status === 403) throw new CloudAuthError('reauth-required');
        if (reason === 'email_not_configured' || status === 501) throw new CloudAuthError('email-not-configured');
        if (reason === 'invalid_email_code' || status === 401) throw new CloudAuthError('invalid-email-code');
        if (reason === 'invalid_secret' || status === 400) throw new CloudAuthError('invalid-account-secret');
        if (status === 429) throw new CloudAuthError('rate-limited');
        throw new CloudAuthError('network');
    }
}

export async function linkGoogleIdentity(
    credential: string,
    nonce: string,
    credentials: AuthCredentials,
): Promise<{ success: true; email: string | null }> {
    try {
        const response = await axios.post<{ success: true; email: string | null }>(
            `${getServerUrl()}/v1/account/identities/google`,
            { credential, nonce, secret: credentials.secret },
            { headers: authenticatedHeaders(credentials) },
        );
        return response.data;
    } catch (error: any) {
        const status = error?.response?.status;
        const reason = error?.response?.data?.error;
        if (reason === 'google_identity_in_use' || status === 409) throw new CloudAuthError('google-identity-in-use');
        if (reason === 'reauth_required') throw new CloudAuthError('reauth-required');
        if (reason === 'origin_not_allowed') throw new CloudAuthError('origin-not-allowed');
        if (reason === 'google_not_configured' || status === 501) throw new CloudAuthError('google-not-configured');
        if (reason === 'invalid_google_credential' || status === 401) throw new CloudAuthError('invalid-credential');
        if (reason === 'invalid_secret' || status === 400) throw new CloudAuthError('invalid-account-secret');
        if (status === 429) throw new CloudAuthError('rate-limited');
        throw new CloudAuthError('network');
    }
}

export async function requestEmailLoginCode(email: string): Promise<EmailLoginChallenge> {
    try {
        const response = await axios.post<EmailLoginChallenge>(
            `${getServerUrl()}/v1/auth/email/code`,
            { email: email.trim().toLowerCase() },
            { headers: { 'X-Happy-Client': getHappyClientId() } },
        );
        return response.data;
    } catch (error: any) {
        const status = error?.response?.status;
        const reason = error?.response?.data?.error;
        if (reason === 'email_delivery_unavailable' || status === 503) throw new CloudAuthError('email-delivery-unavailable');
        if (reason === 'email_not_configured' || status === 501) throw new CloudAuthError('email-not-configured');
        if (status === 429) throw new CloudAuthError('rate-limited');
        throw new CloudAuthError('network');
    }
}

export async function loginWithEmail(
    email: string,
    challengeId: string,
    code: string,
    inviteCode?: string,
): Promise<AuthCredentials> {
    try {
        const response = await axios.post<AuthCredentials>(
            `${getServerUrl()}/v1/account/login/email`,
            {
                email: email.trim().toLowerCase(),
                challengeId,
                code: code.trim(),
                ...(inviteCode?.trim() ? { inviteCode: inviteCode.trim() } : {}),
            },
            { headers: { 'X-Happy-Client': getHappyClientId() } },
        );
        return { token: response.data.token, secret: response.data.secret };
    } catch (error: any) {
        const status = error?.response?.status;
        const reason = error?.response?.data?.error;
        if (reason === 'capacity-reached') throw new CloudAuthError('capacity-reached');
        if (reason === 'invite-required') throw new CloudAuthError('invite-required');
        if (reason === 'signup-closed') throw new CloudAuthError('signup-closed');
        if (reason === 'email_not_configured' || status === 501) throw new CloudAuthError('email-not-configured');
        if (status === 429) throw new CloudAuthError('rate-limited');
        if (reason === 'invalid_email_code' || status === 401) throw new CloudAuthError('invalid-email-code');
        throw new CloudAuthError('network');
    }
}

export async function createGoogleLoginChallenge(): Promise<GoogleLoginChallenge> {
    try {
        const response = await axios.post<GoogleLoginChallenge>(
            `${getServerUrl()}/v1/auth/google/challenge`,
            {},
            { headers: { 'X-Happy-Client': getHappyClientId() } },
        );
        return response.data;
    } catch (error: any) {
        const status = error?.response?.status;
        const reason = error?.response?.data?.error;
        if (reason === 'origin_not_allowed') throw new CloudAuthError('origin-not-allowed');
        if (status === 429) throw new CloudAuthError('rate-limited');
        throw new CloudAuthError('network');
    }
}

export async function loginWithGoogle(
    credential: string,
    nonce: string,
    inviteCode?: string,
): Promise<AuthCredentials> {
    try {
        const response = await axios.post<AuthCredentials>(
            `${getServerUrl()}/v1/account/login/google`,
            { credential, nonce, ...(inviteCode?.trim() ? { inviteCode: inviteCode.trim() } : {}) },
            { headers: { 'X-Happy-Client': getHappyClientId() } },
        );
        return { token: response.data.token, secret: response.data.secret };
    } catch (error: any) {
        const status = error?.response?.status;
        const reason = error?.response?.data?.error;
        if (reason === 'capacity-reached') throw new CloudAuthError('capacity-reached');
        if (reason === 'invite-required') throw new CloudAuthError('invite-required');
        if (reason === 'signup-closed') throw new CloudAuthError('signup-closed');
        if (reason === 'origin_not_allowed') throw new CloudAuthError('origin-not-allowed');
        if (status === 429) throw new CloudAuthError('rate-limited');
        if (status === 401) throw new CloudAuthError('invalid-credential');
        throw new CloudAuthError('network');
    }
}

/**
 * B-620: begin a generic OIDC login. The server creates the PKCE challenge and
 * returns the provider's authorization URL; the caller navigates the browser
 * there. The provider sends the browser back to `/login/oidc?handoff=…`.
 */
export async function startOidcLogin(inviteCode?: string, migrationHandoff?: string): Promise<{ authorizationUrl: string }> {
    try {
        const response = await axios.post<{ authorizationUrl: string }>(
            `${getServerUrl()}/v1/auth/oidc/start`,
            {
                ...(inviteCode?.trim() ? { inviteCode: inviteCode.trim() } : {}),
                // B-627: the callback then claims the account this ticket names.
                ...(migrationHandoff ? { migrationHandoff } : {}),
            },
            { headers: { 'X-Happy-Client': getHappyClientId() } },
        );
        return { authorizationUrl: response.data.authorizationUrl };
    } catch (error: any) {
        const status = error?.response?.status;
        if (status === 401) throw new CloudAuthError('invalid-migration-handoff');
        if (status === 501) throw new CloudAuthError('oidc-not-configured');
        if (status === 503) throw new CloudAuthError('oidc-provider-unavailable');
        if (status === 429) throw new CloudAuthError('rate-limited');
        throw new CloudAuthError('network');
    }
}

/** B-620: exchange the one-time handoff code from `/login/oidc` for the login token + account secret. */
export async function completeOidcLogin(handoff: string): Promise<AuthCredentials & { expiresAt?: string }> {
    try {
        const response = await axios.post<{ token: string; secret: string; expiresAt?: string }>(
            `${getServerUrl()}/v1/auth/oidc/complete`,
            { handoff },
            { headers: { 'X-Happy-Client': getHappyClientId() } },
        );
        return { token: response.data.token, secret: response.data.secret, expiresAt: response.data.expiresAt };
    } catch (error: any) {
        const status = error?.response?.status;
        if (status === 401) throw new CloudAuthError('invalid-handoff');
        if (status === 501) throw new CloudAuthError('oidc-not-configured');
        if (status === 429) throw new CloudAuthError('rate-limited');
        throw new CloudAuthError('network');
    }
}

// B-627: relay-to-relay account migration.

export interface MigrationTarget { url: string; name: string }

/** The old relay's answer to "should this account see the move banner?" (null = no). */
export async function loadMigrationTarget(credentials: AuthCredentials): Promise<MigrationTarget | null> {
    try {
        const response = await axios.get<{ target: MigrationTarget | null }>(`${getServerUrl()}/v1/migration`, {
            headers: { Authorization: `Bearer ${credentials.token}`, 'X-Happy-Client': getHappyClientId() },
        });
        return response.data.target;
    } catch {
        // 404 = a relay without the feature; anything else is not worth a banner either.
        return null;
    }
}

/** Mints the signed ticket and returns the new relay's `/login/migrate` URL to navigate to. */
export async function requestMigrationHandoff(credentials: AuthCredentials): Promise<string> {
    try {
        const response = await axios.post<{ url: string }>(`${getServerUrl()}/v1/migration/handoff`, {}, {
            headers: { Authorization: `Bearer ${credentials.token}`, 'X-Happy-Client': getHappyClientId() },
        });
        return response.data.url;
    } catch (error: any) {
        const status = error?.response?.status;
        if (status === 403) throw new CloudAuthError('not-targeted');
        if (status === 429) throw new CloudAuthError('rate-limited');
        throw new CloudAuthError('network');
    }
}

/** On the new relay: spend the ticket for a login without SSO (used when the relay has no OIDC issuer). */
export async function completeMigrationLogin(handoff: string): Promise<AuthCredentials & { expiresAt?: string }> {
    try {
        const response = await axios.post<{ kind: 'web'; token: string; secret: string; expiresAt?: string }>(
            `${getServerUrl()}/v1/auth/migrate/complete`,
            { handoff },
            { headers: { 'X-Happy-Client': getHappyClientId() } },
        );
        return { token: response.data.token, secret: response.data.secret, expiresAt: response.data.expiresAt };
    } catch (error: any) {
        const status = error?.response?.status;
        if (status === 401) throw new CloudAuthError('invalid-migration-handoff');
        if (status === 429) throw new CloudAuthError('rate-limited');
        throw new CloudAuthError('network');
    }
}

export async function revokeCloudLogin(credentials: AuthCredentials): Promise<void> {
    try {
        await axios.post(
            `${getServerUrl()}/v1/account/logout`,
            {},
            {
                headers: {
                    Authorization: `Bearer ${credentials.token}`,
                    'X-Happy-Client': getHappyClientId(),
                },
            },
        );
    } catch {
        // Old server/offline logout still clears the local browser credential.
    }
}
