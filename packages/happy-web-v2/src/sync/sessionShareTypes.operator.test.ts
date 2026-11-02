import { describe, expect, it } from 'vitest';
import {
    ApiSessionShareUpdatedSchema,
    isOperatingNow,
    OperatorActivityEventSchema,
    SessionGrantViewSchema,
    SessionShareInfoSchema,
    SharedSessionInviteSchema,
    tierOf,
} from './sessionShareTypes';

const grant = {
    id: 'g', sessionId: 's', role: 'driver', status: 'active', createdAt: 1, acceptedAt: 2, expiresAt: 3,
    grantee: { id: 'b', displayName: 'Bob', email: null },
};

describe('B-867 share shapes', () => {
    it('parse with and without operate (pre-B-867 servers omit it)', () => {
        expect(SessionGrantViewSchema.parse(grant).operate).toBeUndefined();
        expect(SessionGrantViewSchema.parse({ ...grant, operate: true }).operate).toBe(true);
        expect(SessionShareInfoSchema.parse({ grantId: 'g', role: 'driver', owner: { id: 'o', displayName: 'O' } }).operate).toBeUndefined();
        expect(SessionShareInfoSchema.parse({ grantId: 'g', role: 'driver', operate: true, expiresAt: 5, owner: { id: 'o', displayName: 'O' } })).toMatchObject({ operate: true, expiresAt: 5 });
        expect(SharedSessionInviteSchema.parse({
            id: 'g', sessionId: 's', role: 'driver', operate: true, status: 'pending', createdAt: 1, expiresAt: 2,
            owner: { id: 'o', displayName: 'O', username: null, avatarUrl: null }, session: { name: null, path: null, host: null },
        }).operate).toBe(true);
        expect(ApiSessionShareUpdatedSchema.parse({ t: 'session-share-updated', sessionId: 's', grantId: 'g', role: 'driver', status: 'active', operate: false }).operate).toBe(false);
    });
    it('the wire role never carries "operator" (old webs keep parsing)', () => {
        expect(SessionGrantViewSchema.safeParse({ ...grant, role: 'operator' }).success).toBe(false);
    });
    it('maps wire shape to a dialog tier', () => {
        expect(tierOf({ role: 'driver', operate: true })).toBe('operator');
        expect(tierOf({ role: 'driver' })).toBe('driver');
        expect(tierOf({ role: 'viewer', operate: true })).toBe('viewer');
    });
    it('"operating now" = an open terminal or activity in the last two minutes', () => {
        const now = 1_000_000;
        expect(isOperatingNow({ openTerminals: 1, lastActivityAt: null }, now)).toBe(true);
        expect(isOperatingNow({ openTerminals: 0, lastActivityAt: now - 60_000 }, now)).toBe(true);
        expect(isOperatingNow({ openTerminals: 0, lastActivityAt: now - 3 * 60_000 }, now)).toBe(false);
        expect(isOperatingNow({ openTerminals: 0, lastActivityAt: null }, now)).toBe(false);
        expect(OperatorActivityEventSchema.safeParse({ sessionId: 's', granteeAccountId: 'b', displayName: 'Bob', openTerminals: 0, lastActivityAt: null }).success).toBe(true);
    });
});
