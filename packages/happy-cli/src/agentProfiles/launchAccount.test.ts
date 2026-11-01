import { describe, expect, it, vi } from 'vitest';
import { accountUnavailableError, forkSpawnAccount } from './launchAccount';

describe('B-850d forkSpawnAccount', () => {
    it('the spawn\'s own choice wins (id or machine login)', () => {
        const parent = vi.fn(() => 'parent-acct');
        expect(forkSpawnAccount('x', 'p', parent)).toBe('x');
        expect(forkSpawnAccount(null, 'p', parent)).toBeNull();
        expect(parent).not.toHaveBeenCalled();
    });
    it('a fork continues on the parent\'s account; an unbound parent = machine login (not the machine default)', () => {
        expect(forkSpawnAccount(undefined, 'p', () => 'parent-acct')).toBe('parent-acct');
        expect(forkSpawnAccount(undefined, 'p', () => null)).toBeNull();
    });
    it('not a fork → undefined (machine default)', () => {
        expect(forkSpawnAccount(undefined, undefined, () => 'x')).toBeUndefined();
    });
});

describe('B-850d accountUnavailableError', () => {
    it('names the reason, says it did not fall back, and both ways out', () => {
        const text = accountUnavailableError('agent-profile-unavailable:missing: no account "org-a" on this machine', 'team member')!;
        expect(text).toBe('Account unavailable (missing): no account "org-a" on this machine — does not exist on this machine. Not run on the machine login. Fix: sign in again (Settings → Models & accounts, or `very-happy account login` / `very-happy account test`), or choose another account for this team member.');
    });
    it('other spawn errors are not account errors', () => {
        expect(accountUnavailableError('Directory does not exist', 'automation')).toBeNull();
    });
});
