import { describe, expect, it } from 'vitest';
import { groupPeople, incomingRequestCount, personSubline, searchActionFor } from './peoplePresentation';
import type { UserProfile } from '@/sync/friendTypes';

const p = (over: Partial<UserProfile>): UserProfile => ({ id: 'x', firstName: '', lastName: null, avatar: null, username: '', bio: null, status: 'none', ...over });

describe('people presentation (B-621)', () => {
    it('groups by my point of view and sorts by display name', () => {
        const all = [
            p({ id: 'b', username: 'bob', status: 'friend' }),
            p({ id: 'a', username: 'alice', status: 'friend' }),
            p({ id: 'c', username: 'carol', status: 'pending' }),
            p({ id: 'd', username: 'dan', status: 'requested' }),
            p({ id: 'e', username: 'eve', status: 'rejected' }),
        ];
        const g = groupPeople(all);
        expect(g.friends.map((x) => x.id)).toEqual(['a', 'b']);
        expect(g.incoming.map((x) => x.id)).toEqual(['c']);
        expect(g.outgoing.map((x) => x.id)).toEqual(['d']);
        expect(incomingRequestCount(all)).toBe(1);
    });
    it('subline never repeats the display name', () => {
        expect(personSubline(p({ username: 'alice' }))).toBe('');
        expect(personSubline(p({ firstName: 'Alice', username: 'alice', email: 'a@x.io' }))).toBe('@alice · a@x.io');
        expect(personSubline(p({ displayName: 'a@x.io', email: 'a@x.io' }))).toBe('');
    });
    it('search row verb follows the relationship', () => {
        expect(searchActionFor('none')).toBe('add');
        expect(searchActionFor('rejected')).toBe('add');
        expect(searchActionFor('pending')).toBe('accept');
        expect(searchActionFor('requested')).toBe('cancel');
        expect(searchActionFor('friend')).toBe('none');
    });
});
