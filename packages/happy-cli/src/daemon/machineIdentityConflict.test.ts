import { describe, expect, it } from 'vitest';
import { describeMachineIdentityConflict, detectMachineIdentityConflict } from './machineIdentityConflict';

const here = { host: 'dsw-b', platform: 'linux', homeDir: '/home/b' };

describe('detectMachineIdentityConflict', () => {
    it('is silent for the machine that owns the row', () => {
        expect(detectMachineIdentityConflict({ ...here }, here)).toBeNull();
    });

    it('is silent when the machine row was just created', () => {
        expect(detectMachineIdentityConflict(null, here)).toBeNull();
        expect(detectMachineIdentityConflict(undefined, here)).toBeNull();
    });

    it('is silent for fields the old record never carried', () => {
        expect(detectMachineIdentityConflict({}, here)).toBeNull();
        expect(detectMachineIdentityConflict({ host: undefined, platform: '' }, here)).toBeNull();
    });

    it('ignores the -dev variant suffix — that daemon shares ~/.happy by design', () => {
        expect(detectMachineIdentityConflict({ ...here, host: 'dsw-b-dev' }, here)).toBeNull();
        expect(detectMachineIdentityConflict({ ...here }, { ...here, host: 'dsw-b-dev' })).toBeNull();
    });

    it('treats a hostname-only difference as weak — a rename explains it', () => {
        const conflict = detectMachineIdentityConflict({ ...here, host: 'dsw-a' }, here);
        expect(conflict).toMatchObject({ confidence: 'weak', fields: ['host'] });
    });

    it('treats a different home dir or platform as strong evidence of a copied ~/.happy', () => {
        expect(detectMachineIdentityConflict({ ...here, homeDir: '/home/a' }, here))
            .toMatchObject({ confidence: 'strong', fields: ['homeDir'] });
        expect(detectMachineIdentityConflict({ host: 'mac-office', platform: 'darwin', homeDir: '/Users/jojo' }, here))
            .toMatchObject({ confidence: 'strong', fields: ['host', 'platform', 'homeDir'] });
    });

    it('ignores non-string metadata rather than reporting a bogus conflict', () => {
        expect(detectMachineIdentityConflict({ host: 42, platform: null, homeDir: {} }, here)).toBeNull();
    });
});

describe('describeMachineIdentityConflict', () => {
    it('names the offending fields and points at the command that actually mints a machine id', () => {
        const conflict = detectMachineIdentityConflict({ host: 'mac-office', platform: 'darwin', homeDir: '/Users/jojo' }, here)!;
        const text = describeMachineIdentityConflict(conflict);
        expect(text).toContain('very-happy auth login --force');
        expect(text).toContain('recorded=mac-office');
        expect(text).toContain('current=dsw-b');
        // `doctor clean` only kills processes; recommending it here was the old bug.
        expect(text).not.toContain('doctor clean');
    });
});
