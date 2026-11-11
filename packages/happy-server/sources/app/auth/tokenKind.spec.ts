import { describe, expect, it, vi } from 'vitest';
import { requestTokenKind, requireHumanOwner } from './tokenKind';

describe('requestTokenKind / requireHumanOwner (B-921)', () => {
    it('a login session is human; anything else is a machine', () => {
        expect(requestTokenKind({ authLoginSessionId: 'ls-1' })).toBe('human');
        for (const id of [undefined, '']) expect(requestTokenKind({ authLoginSessionId: id })).toBe('machine');
    });
    it('refuses a machine with 403 owner_login_required', () => {
        const send = vi.fn(); const reply = { code: vi.fn(() => ({ send })) } as any;
        expect(requireHumanOwner({ authLoginSessionId: 'ls-1' }, reply)).toBe(true);
        expect(reply.code).not.toHaveBeenCalled();
        expect(requireHumanOwner({}, reply)).toBe(false);
        expect(reply.code).toHaveBeenCalledWith(403);
        expect(send).toHaveBeenCalledWith({ error: 'owner_login_required' });
    });
});
