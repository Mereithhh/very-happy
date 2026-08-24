import { describe, expect, it } from 'vitest';
import { localMachineIdentityStatus } from './authStatusFacts';

describe('auth status machine identity facts', () => {
    it('does not turn a local machineId into a remote registration claim', () => {
        const status = localMachineIdentityStatus('local-machine-id');
        expect(status.configured).toBe(true);
        expect(status.label).toContain('Local machine identity configured');
        expect(status.label).toContain('relay registration not checked');
        expect(status.label).not.toContain('Machine registered');
    });

    it('gives a recovery action when the local identity is missing', () => {
        expect(localMachineIdentityStatus(undefined)).toEqual({
            configured: false,
            label: 'Local machine identity missing',
            nextStep: 'Run "very-happy auth login --force" to create and register one',
        });
    });
});
