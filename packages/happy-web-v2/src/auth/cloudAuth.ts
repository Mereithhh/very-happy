import axios from 'axios';
import { getServerUrl } from '@/sync/serverConfig';
import { getHappyClientId } from '@/sync/apiSocket';
import type { AuthCredentials } from './tokenStorage';

export type SignupMode = 'open' | 'invite' | 'closed';

export interface PublicAuthConfig {
    googleClientId?: string;
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
