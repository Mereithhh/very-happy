import { describe, expect, it } from 'vitest';
import { terminalConnectionNotice } from './termConnectionState';
const online = { controlConnected: true, regionalConnected: false, machineActive: true, opening: false, failed: false };
describe('terminal connection notice', () => {
    it('distinguishes an offline target from an opening terminal', () => {
        expect(terminalConnectionNotice({ ...online, machineActive: false, opening: true })).toBe('offline');
        expect(terminalConnectionNotice({ ...online, opening: true })).toBe('connecting');
    });
    it('does not report cached offline presence as fact when control is disconnected', () => {
        expect(terminalConnectionNotice({ ...online, machineActive: false, controlConnected: false })).toBe('checking');
    });
    it('leaves an established regional terminal usable during control loss', () => {
        expect(terminalConnectionNotice({ ...online, controlConnected: false, regionalConnected: true })).toBe(null);
        expect(terminalConnectionNotice({ ...online, controlConnected: false, regionalConnected: true, opening: true })).toBe('checking');
    });
    it('stops loading on failure and clears the notice after success', () => {
        expect(terminalConnectionNotice({ ...online, failed: true, opening: true })).toBe('failed');
        expect(terminalConnectionNotice(online)).toBe(null);
    });
});
