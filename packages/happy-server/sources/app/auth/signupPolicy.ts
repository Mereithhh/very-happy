import type { Prisma } from '@prisma/client';
import { db } from '@/storage/db';

export type SignupMode = 'open' | 'invite' | 'closed';
export type SignupProvider = 'password' | 'google' | 'email' | 'key' | 'oidc';
export type SignupRejectionReason = 'signup-closed' | 'invite-required' | 'capacity-reached';

export interface SignupPolicy {
    mode: SignupMode;
    maxAccounts: number | null;
    inviteCodes: readonly string[];
    /**
     * `OIDC_SIGNUP_MODE`: mode applied to first logins through the generic OIDC
     * issuer instead of `SIGNUP_MODE`; null inherits. Lets an invite-only relay
     * admit everyone the IdP (plus `OIDC_ALLOWED_EMAIL_DOMAINS`) vouches for
     * without handing out codes. Capacity still applies.
     */
    oidcMode: SignupMode | null;
}

export interface SignupStatus {
    mode: SignupMode;
    maxAccounts: number | null;
    registeredAccounts: number;
    remainingAccounts: number | null;
    atCapacity: boolean;
}

export class SignupPolicyError extends Error {
    readonly reason: SignupRejectionReason;

    constructor(reason: SignupRejectionReason) {
        super(reason);
        this.name = 'SignupPolicyError';
        this.reason = reason;
    }
}

function parsePositiveInteger(value: string | undefined): number | null {
    if (!value || value.trim() === '' || value.trim() === '0') return null;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 1) {
        throw new Error('SIGNUP_MAX_ACCOUNTS must be a positive integer, 0, or unset');
    }
    return parsed;
}

function parseSignupMode(raw: string | undefined, name: string): SignupMode | null {
    const value = raw?.trim().toLowerCase();
    if (!value) return null;
    if (value === 'open' || value === 'invite' || value === 'closed') return value;
    throw new Error(`${name} must be open, invite, or closed`);
}

export function resolveSignupPolicy(env: NodeJS.ProcessEnv = process.env): SignupPolicy {
    const inviteCodes = (env.SIGNUP_INVITE_CODES ?? '')
        .split(',')
        .map((code) => code.trim())
        .filter(Boolean);

    const explicitMode = parseSignupMode(env.SIGNUP_MODE, 'SIGNUP_MODE');
    let mode: SignupMode;
    if (explicitMode) {
        mode = explicitMode;
    } else if (env.SIGNUP_CLOSED === '1' || env.SIGNUP_CLOSED === 'true') {
        mode = 'closed';
    } else if (inviteCodes.length > 0) {
        mode = 'invite';
    } else {
        // A missing production environment variable must never silently turn
        // a new relay into an unlimited public registration endpoint.
        mode = 'closed';
    }

    return {
        mode,
        maxAccounts: parsePositiveInteger(env.SIGNUP_MAX_ACCOUNTS),
        inviteCodes,
        oidcMode: parseSignupMode(env.OIDC_SIGNUP_MODE, 'OIDC_SIGNUP_MODE'),
    };
}

/** Mode that gates a first login through `provider`. */
export function signupModeFor(policy: SignupPolicy, provider?: SignupProvider): SignupMode {
    return provider === 'oidc' && policy.oidcMode ? policy.oidcMode : policy.mode;
}

export function getSignupRejection(
    policy: SignupPolicy,
    registeredAccounts: number,
    inviteCode?: string,
    provider?: SignupProvider,
): SignupRejectionReason | null {
    const mode = signupModeFor(policy, provider);
    if (mode === 'closed') return 'signup-closed';
    if (mode === 'invite') {
        const normalized = inviteCode?.trim();
        if (!normalized || !policy.inviteCodes.includes(normalized)) return 'invite-required';
    }
    if (policy.maxAccounts !== null && registeredAccounts >= policy.maxAccounts) {
        return 'capacity-reached';
    }
    return null;
}

export function buildSignupStatus(policy: SignupPolicy, registeredAccounts: number): SignupStatus {
    const remainingAccounts = policy.maxAccounts === null
        ? null
        : Math.max(0, policy.maxAccounts - registeredAccounts);
    return {
        mode: policy.mode,
        maxAccounts: policy.maxAccounts,
        registeredAccounts,
        remainingAccounts,
        atCapacity: remainingAccounts === 0,
    };
}

export async function getSignupStatus(): Promise<SignupStatus> {
    const registeredAccounts = await db.account.count();
    return buildSignupStatus(resolveSignupPolicy(), registeredAccounts);
}

interface WithSignupGateOptions<T> {
    provider: SignupProvider;
    inviteCode?: string;
    findExisting: (tx: Prisma.TransactionClient) => Promise<T | null>;
    create: (tx: Prisma.TransactionClient) => Promise<T>;
    onRejected?: (reason: SignupRejectionReason, provider: SignupProvider) => void;
}

/**
 * Re-checks identity existence after taking the singleton row lock. Existing
 * identities bypass signup policy; only creation of a new Account consumes
 * capacity. The lock makes the final slot safe across server replicas.
 */
export async function withSignupGate<T>(options: WithSignupGateOptions<T>): Promise<{ value: T; created: boolean }> {
    return db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
            'INSERT INTO "SignupCapacity" ("id", "updatedAt") VALUES (1, now()) ON CONFLICT ("id") DO NOTHING',
        );
        await tx.$queryRawUnsafe('SELECT "id" FROM "SignupCapacity" WHERE "id" = 1 FOR UPDATE');

        const existing = await options.findExisting(tx);
        if (existing !== null) return { value: existing, created: false };

        const registeredAccounts = await tx.account.count();
        const rejection = getSignupRejection(resolveSignupPolicy(), registeredAccounts, options.inviteCode, options.provider);
        if (rejection) {
            options.onRejected?.(rejection, options.provider);
            throw new SignupPolicyError(rejection);
        }

        return { value: await options.create(tx), created: true };
    });
}
