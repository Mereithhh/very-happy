import { describe, expect, it } from 'vitest';
import { withSessionPermissionMode } from './sessionPermissionPreference';

describe('withSessionPermissionMode', () => {
    it('can remember a spawn mode before the session snapshot exists', () => {
        expect(withSessionPermissionMode({}, 'new-session', 'plan')).toEqual({
            'new-session': 'plan',
        });
    });

    it('preserves other sessions and removes only the cleared override', () => {
        expect(withSessionPermissionMode({ a: 'plan', b: 'bypassPermissions' }, 'a', null)).toEqual({
            b: 'bypassPermissions',
        });
    });
});
