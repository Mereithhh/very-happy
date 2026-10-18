/**
 * Account directory (B-621) — the ONE place that answers "who is this
 * person" for every people-facing feature: session sharing (B-619), friends,
 * and the later Space / message-adapter work.
 *
 * Two names live on an account and they are deliberately distinct:
 *   - the LOGIN username (`AccountCredential.username`, password sign-ups only)
 *   - the PROFILE handle (`Account.username`, unique, what others search for)
 * A password sign-up seeds the handle from the login username when it is free
 * (migration 20261018100000 backfills existing rows); the handle can then be
 * changed in Settings without touching the login. Lookups accept either, plus
 * a verified email, so nobody has to know which one a colleague has.
 */
import type { Prisma } from '@prisma/client';
import { RelationshipStatus } from '@prisma/client';
import { z } from 'zod';
import { db } from '@/storage/db';
import { buildUserProfile, type UserProfile } from './type';

export const profileInclude = { githubUser: true } as const;
export type ProfileAccount = Prisma.AccountGetPayload<{ include: typeof profileInclude }>;

/** Profile handle rules: lowercase, 3–64, letters/digits/`_`/`.`/`-`. Same alphabet the signup username uses. */
export const PROFILE_USERNAME_PATTERN = /^[a-z0-9][a-z0-9_.-]{2,63}$/;
export const profileUsernameSchema = z.string().trim().toLowerCase().regex(PROFILE_USERNAME_PATTERN);
export const profileNameSchema = z.string().trim().max(80);

export type AccountIdentity = { handle: string | null; email: string | null };

/** Profile name → profile handle → login username → email local part. */
export function displayNameOf(
    account: { firstName: string | null; lastName: string | null; username: string | null },
    identity?: { handle?: string | null; email?: string | null },
): string {
    const full = [account.firstName, account.lastName].filter(Boolean).join(' ').trim();
    if (full) return full;
    if (account.username) return account.username;
    if (identity?.handle) return identity.handle;
    if (identity?.email) return identity.email.split('@')[0];
    return 'someone';
}

export async function primaryEmail(accountId: string, tx: Prisma.TransactionClient = db): Promise<string | null> {
    const identity = await tx.accountIdentity.findFirst({ where: { accountId, email: { not: null } }, select: { email: true }, orderBy: { createdAt: 'asc' } });
    return identity?.email ?? null;
}

export async function identityOf(accountId: string, tx: Prisma.TransactionClient = db): Promise<AccountIdentity> {
    const [credential, email] = await Promise.all([
        tx.accountCredential.findUnique({ where: { accountId }, select: { username: true } }),
        primaryEmail(accountId, tx),
    ]);
    return { handle: credential?.username ?? null, email };
}

/** Public-facing profile: UserProfile plus a display name that never comes back empty. */
export type DirectoryProfile = UserProfile & { displayName: string; email: string | null };

export async function directoryProfileOf(account: ProfileAccount, status: RelationshipStatus, tx: Prisma.TransactionClient = db): Promise<DirectoryProfile> {
    const identity = await identityOf(account.id, tx);
    const profile = buildUserProfile(account, status);
    return {
        ...profile,
        username: profile.username || identity.handle || '',
        displayName: displayNameOf(account, identity),
        email: identity.email,
    };
}

/**
 * Resolve one account from what a person types: a verified email (exact,
 * case-insensitive), a profile handle, or a login username. Never a prefix —
 * this is the path that grants access, so it must not guess.
 */
export async function resolveAccountByHandle(target: string, tx: Prisma.TransactionClient = db): Promise<ProfileAccount | null> {
    const trimmed = target.trim();
    if (!trimmed) return null;
    if (trimmed.includes('@')) {
        const identity = await tx.accountIdentity.findFirst({
            where: { email: { equals: trimmed, mode: 'insensitive' } },
            select: { accountId: true },
            orderBy: { createdAt: 'asc' },
        });
        if (!identity) return null;
        return tx.account.findUnique({ where: { id: identity.accountId }, include: profileInclude });
    }
    const byProfile = await tx.account.findFirst({ where: { username: { equals: trimmed, mode: 'insensitive' } }, include: profileInclude });
    if (byProfile) return byProfile;
    const credential = await tx.accountCredential.findFirst({ where: { username: { equals: trimmed, mode: 'insensitive' } }, select: { accountId: true } });
    return credential ? tx.account.findUnique({ where: { id: credential.accountId }, include: profileInclude }) : null;
}

export async function relationshipStatusBetween(viewerId: string, otherId: string, tx: Prisma.TransactionClient = db): Promise<RelationshipStatus> {
    if (viewerId === otherId) return RelationshipStatus.none;
    const row = await tx.userRelationship.findUnique({ where: { fromUserId_toUserId: { fromUserId: viewerId, toUserId: otherId } }, select: { status: true } });
    return row?.status ?? RelationshipStatus.none;
}

/**
 * People search for the directory UI: handle / login-username PREFIX (case-
 * insensitive) or exact email. Returns at most `limit` accounts, never the
 * viewer, each with the viewer's relationship status. Emails are matched only
 * exactly so the search box cannot be used to enumerate addresses.
 */
export async function searchAccounts(viewerId: string, query: string, limit = 10): Promise<DirectoryProfile[]> {
    const q = query.trim();
    if (!q) return [];
    const ids = new Set<string>();
    if (q.includes('@')) {
        const identities = await db.accountIdentity.findMany({ where: { email: { equals: q, mode: 'insensitive' } }, select: { accountId: true }, take: limit });
        identities.forEach((row) => ids.add(row.accountId));
    } else {
        const [profiles, credentials] = await Promise.all([
            db.account.findMany({ where: { username: { startsWith: q, mode: 'insensitive' } }, select: { id: true }, orderBy: { username: 'asc' }, take: limit }),
            db.accountCredential.findMany({ where: { username: { startsWith: q, mode: 'insensitive' } }, select: { accountId: true }, orderBy: { username: 'asc' }, take: limit }),
        ]);
        profiles.forEach((row) => ids.add(row.id));
        credentials.forEach((row) => ids.add(row.accountId));
    }
    ids.delete(viewerId);
    const picked = Array.from(ids).slice(0, limit);
    if (picked.length === 0) return [];
    const accounts = await db.account.findMany({ where: { id: { in: picked } }, include: profileInclude });
    const out: DirectoryProfile[] = [];
    for (const account of accounts) {
        out.push(await directoryProfileOf(account, await relationshipStatusBetween(viewerId, account.id)));
    }
    return out.sort((a, b) => (a.username || a.displayName).localeCompare(b.username || b.displayName));
}

/** True when no OTHER account already uses `username` as its profile handle or login username. */
export async function isProfileUsernameFree(username: string, accountId: string, tx: Prisma.TransactionClient = db): Promise<boolean> {
    const [profile, credential] = await Promise.all([
        tx.account.findFirst({ where: { username: { equals: username, mode: 'insensitive' }, NOT: { id: accountId } }, select: { id: true } }),
        tx.accountCredential.findFirst({ where: { username: { equals: username, mode: 'insensitive' }, NOT: { accountId } }, select: { accountId: true } }),
    ]);
    return !profile && !credential;
}

/**
 * Seed the profile handle from a login username at sign-up time. Best effort:
 * a taken handle leaves the profile handle null (the person picks one later).
 */
export async function seedProfileUsername(tx: Prisma.TransactionClient, accountId: string, candidate: string | null | undefined): Promise<void> {
    if (!candidate) return;
    const parsed = profileUsernameSchema.safeParse(candidate);
    if (!parsed.success) return;
    if (!(await isProfileUsernameFree(parsed.data, accountId, tx))) return;
    await tx.account.update({ where: { id: accountId }, data: { username: parsed.data } });
}

export class ProfileUsernameTakenError extends Error {
    constructor() { super('username_taken'); }
}

export type ProfileUpdate = { firstName?: string | null; lastName?: string | null; username?: string | null };

/** Update the editable profile fields. `username: null` clears the handle. Throws ProfileUsernameTakenError. */
export async function updateAccountProfile(accountId: string, patch: ProfileUpdate): Promise<ProfileAccount> {
    return db.$transaction(async (tx) => {
        const data: Prisma.AccountUpdateInput = {};
        if (patch.firstName !== undefined) data.firstName = patch.firstName ? profileNameSchema.parse(patch.firstName) || null : null;
        if (patch.lastName !== undefined) data.lastName = patch.lastName ? profileNameSchema.parse(patch.lastName) || null : null;
        if (patch.username !== undefined) {
            if (patch.username === null || patch.username.trim() === '') {
                data.username = null;
            } else {
                const username = profileUsernameSchema.parse(patch.username);
                if (!(await isProfileUsernameFree(username, accountId, tx))) throw new ProfileUsernameTakenError();
                data.username = username;
            }
        }
        return tx.account.update({ where: { id: accountId }, data, include: profileInclude });
    });
}
