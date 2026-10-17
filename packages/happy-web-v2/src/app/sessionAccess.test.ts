import { describe, expect, it } from 'vitest';
import { canSendAsGrantee, isSharedWithMe, sessionAccess } from './sessionAccess';

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
});
