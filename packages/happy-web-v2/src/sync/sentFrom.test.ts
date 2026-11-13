import { describe, expect, it } from 'vitest';
import { isOwnerTypedMessage, OWNER_SENT_FROM } from '@slopus/happy-wire';
import { resolveSentFrom } from './sentFrom';

describe('B-924e resolveSentFrom', () => {
    it('every value the composer can write is the owner typing (Mac Catalyst included)', () => {
        const cases: Array<[string, boolean, string]> = [
            ['web', false, 'web'], ['android', false, 'android'], ['ios', false, 'ios'], ['ios', true, 'mac'],
            ['macos', false, 'web'], ['windows', false, 'web'],
        ];
        for (const [os, onMac, expected] of cases) {
            const v = resolveSentFrom(os, () => onMac);
            expect(v, `${os}/${onMac}`).toBe(expected);
            expect((OWNER_SENT_FROM as readonly string[]).includes(v), v).toBe(true);
            expect(isOwnerTypedMessage('c0ffee', v), v).toBe(true);
        }
    });
});
