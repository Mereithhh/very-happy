import { describe, expect, it } from 'vitest';
import { machinePresenceRoom } from '../socket';

describe('machinePresenceRoom', () => {
    it('scopes handover presence by account and machine', () => {
        expect(machinePresenceRoom('account-a', 'machine-1')).toBe('presence:machine:account-a:machine-1');
        expect(machinePresenceRoom('account-b', 'machine-1')).not.toBe(machinePresenceRoom('account-a', 'machine-1'));
    });
});
