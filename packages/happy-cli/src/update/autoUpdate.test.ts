import { describe, expect, it } from 'vitest';
import { autoUpdateInstallArgs, decideAutoUpdate } from './autoUpdate';

const base = {
    enabled: true,
    currentVersion: '0.2.100',
    recommendedVersion: '0.2.115',
    idle: true,
} as const;

describe('decideAutoUpdate', () => {
    it('installs the recommended version on an idle machine', () => {
        expect(decideAutoUpdate(base)).toEqual({ action: 'install', version: '0.2.115' });
    });

    it('never acts while the machine is busy', () => {
        // A running wrapper keeps its own code (iron rule 14) and a terminal's
        // owner process would be swapped underneath it.
        expect(decideAutoUpdate({ ...base, idle: false }).action).toBe('skip');
    });

    it('does nothing until an operator has promoted a release', () => {
        // An unpinned relay must not be read as "take whatever npm calls latest".
        expect(decideAutoUpdate({ ...base, recommendedVersion: null }).action).toBe('skip');
    });

    it('is off when the setting is off', () => {
        expect(decideAutoUpdate({ ...base, enabled: false }).action).toBe('skip');
    });

    it('does nothing when already on the recommended version', () => {
        expect(decideAutoUpdate({ ...base, currentVersion: '0.2.115' }).action).toBe('skip');
    });

    it('never downgrades a machine that is ahead of the recommendation', () => {
        // The normal state right after a release: the machine took the new
        // version before the operator promoted it. Equality alone let this
        // through, and the machine would have installed the older build.
        expect(decideAutoUpdate({ ...base, currentVersion: '0.2.116', recommendedVersion: '0.2.115' }))
            .toEqual({ action: 'skip', reason: 'already ahead of the recommended 0.2.115' });
    });

    it('refuses to act on versions it cannot compare', () => {
        expect(decideAutoUpdate({ ...base, currentVersion: 'dev' }).action).toBe('skip');
        expect(decideAutoUpdate({ ...base, recommendedVersion: 'latest' }).action).toBe('skip');
    });

    it('does not retry a version that already failed to install', () => {
        // npm has left a half-written tree in production once; retrying in a
        // loop is how that becomes permanent.
        expect(decideAutoUpdate({ ...base, failedVersion: '0.2.115' }).action).toBe('skip');
        // ...but a newer recommendation is a fresh attempt.
        expect(decideAutoUpdate({ ...base, failedVersion: '0.2.114' }))
            .toEqual({ action: 'install', version: '0.2.115' });
    });

    it('explains every skip, because the reason is reported to the operator', () => {
        const skipped = decideAutoUpdate({ ...base, idle: false });
        expect(skipped.action === 'skip' && skipped.reason).toContain('busy');
    });
});

describe('autoUpdateInstallArgs', () => {
    it('pins the version and keeps npm deny-by-default for scripts', () => {
        expect(autoUpdateInstallArgs('0.2.115')).toEqual([
            'i', '-g', '--allow-scripts=very-happy-cli,node-pty', 'very-happy-cli@0.2.115',
        ]);
    });
});
