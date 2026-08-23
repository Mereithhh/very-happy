import type { Prisma } from '@prisma/client';
import { db } from '@/storage/db';

export type SignupMode = 'open' | 'invite' | 'closed';
export type SignupProvider = 'password' | 'google' | 'key';
export type SignupRejectionReason = 'signup-closed' | 'invite-required' | 'capacity-reached';

export interface SignupPolicy {
    mode: SignupMode;
    maxAccounts: number | null;
    inviteCodes: readonly string[];
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

export function resolveSignupPolicy(env: NodeJS.ProcessEnv = process.env): SignupPolicy {
    const inviteCodes = (env.SIGNUP_INVITE_CODES ?? '')
        .split(',')
        .map((code) => code.trim())
        .filter(Boolean);

    const explicitMode = env.SIGNUP_MODE?.trim().toLowerCase();
    let mode: SignupMode;
    if (explicitMode === 'open' || explicitMode === 'invite' || explicitMode === 'closed') {
        mode = explicitMode;
    } else if (explicitMode) {
        throw new Error('SIGNUP_MODE must be open, invite, or closed');
    } else if (env.SIGNUP_CLOSED === '1' || env.SIGNUP_CLOSED === 'true') {
        mode = 'closed';
    } else if (inviteCodes.length > 0) {
        mode = 'invite';
    } else {
        mode = 'open';
    }

    return {
        mode,
        maxAccounts: parsePositiveInteger(env.SIGNUP_MAX_ACCOUNTS),
        inviteCodes,
    };
}

export function getSignupRejection(
    policy: SignupPolicy,
    registeredAccounts: number,
    inviteCode?: string,
): SignupRejectionReason | null {
    if (policy.mode === 'closed') return 'signup-closed';
    if (policy.mode === 'invite') {
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
        const rejection = getSignupRejection(resolveSignupPolicy(), registeredAccounts, options.inviteCode);
        if (rejection) {
            options.onRejected?.(rejection, options.provider);
            throw new SignupPolicyError(rejection);
        }

        return { value: await options.create(tx), created: true };
    });
}
