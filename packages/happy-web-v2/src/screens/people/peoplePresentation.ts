/**
 * People screen (B-621) — pure presentation logic, no React.
 *
 * Relationship rows are stored from MY point of view (`status` of the row
 * me → them):
 *   pending   = they asked me        (incoming, I answer)
 *   requested = I asked them         (outgoing, I can cancel)
 *   friend    = mutual
 *   rejected  = I declined them      (hidden; a repeat request stays silent)
 */
import type { UserProfile } from '@/sync/friendTypes';
import { getDisplayName } from '@/sync/friendTypes';

export type PeopleGroups = {
    incoming: UserProfile[];
    friends: UserProfile[];
    outgoing: UserProfile[];
};

function byName(a: UserProfile, b: UserProfile): number {
    return getDisplayName(a).localeCompare(getDisplayName(b));
}

export function groupPeople(all: UserProfile[]): PeopleGroups {
    return {
        incoming: all.filter((p) => p.status === 'pending').sort(byName),
        friends: all.filter((p) => p.status === 'friend').sort(byName),
        outgoing: all.filter((p) => p.status === 'requested').sort(byName),
    };
}

/** Count that rides on the sidebar entry: only things waiting for ME. */
export function incomingRequestCount(all: UserProfile[]): number {
    return all.filter((p) => p.status === 'pending').length;
}

/** Secondary line under a name: handle and/or email, never a duplicate of the name. */
export function personSubline(p: UserProfile): string {
    const name = getDisplayName(p);
    const parts: string[] = [];
    if (p.username && p.username !== name) parts.push(`@${p.username}`);
    if (p.email && p.email !== name) parts.push(p.email);
    return parts.join(' · ');
}

/** Which verb the search result row offers. */
export type SearchAction = 'add' | 'accept' | 'cancel' | 'none';
export function searchActionFor(status: UserProfile['status']): SearchAction {
    switch (status) {
        case 'none':
        case 'rejected': return 'add';
        case 'pending': return 'accept';
        case 'requested': return 'cancel';
        default: return 'none';
    }
}

export function initialsOf(name: string): string {
    return name.trim().slice(0, 1).toUpperCase() || '?';
}
