import { describe, expect, it } from 'vitest';
import { canOperate, canSendAsGrantee, isSharedWithMe, sessionAccess } from './sessionAccess';

describe('B-619 sessionAccess', () => {
    const share = (role: 'viewer' | 'driver') => ({ share: { grantId: 'g', role, owner: { id: 'o', displayName: 'Owner' } } });
    it('no share info means owner', () => {
        expect(sessionAccess(null)).toBe('owner');
        expect(sessionAccess({ share: undefined })).toBe('owner');
        expect(isSharedWithMe({ share: undefined })).toBe(false);
        expect(canSendAsGrantee({ share: undefined })).toBe(false);
    });
    it('maps roles', () => {
        expect(sessionAccess(share('viewer'))).toBe('viewer');
        expect(sessionAccess(share('driver'))).toBe('driver');
        expect(isSharedWithMe(share('viewer'))).toBe(true);
        expect(canSendAsGrantee(share('viewer'))).toBe(false);
        expect(canSendAsGrantee(share('driver'))).toBe(true);
    });

    it('B-867: operator = driver + operate; anything else is not', () => {
        const op = { share: { grantId: 'g', role: 'driver' as const, operate: true, owner: { id: 'o', displayName: 'Owner' } } };
        expect(sessionAccess(op)).toBe('operator');
        expect(canOperate(op)).toBe(true);
        expect(canSendAsGrantee(op)).toBe(true);
        expect(canOperate(share('driver'))).toBe(false);
        expect(canOperate({ share: { grantId: 'g', role: 'viewer' as const, operate: true, owner: { id: 'o', displayName: 'Owner' } } })).toBe(false);
        expect(sessionAccess({ share: { grantId: 'g', role: 'viewer' as const, operate: true, owner: { id: 'o', displayName: 'Owner' } } })).toBe('viewer');
        expect(canOperate(null)).toBe(false);
    });
});

