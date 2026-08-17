import { describe, it, expect } from 'vitest';
import { isSafeControlCommand, CONTROL_CLIENT_KILL_GRACE_MS } from './controlClient';

describe('isSafeControlCommand', () => {
    it('accepts ordinary tmux commands', () => {
        expect(isSafeControlCommand('capture-pane -peqJN -t %1 -S -5000')).toBe(true);
        expect(isSafeControlCommand("send-keys -lt %1 -- 'hello world'")).toBe(true);
        expect(isSafeControlCommand('refresh-client -C 80x24')).toBe(true);
    });

    it('refuses a blank line — an empty line on a control client is DETACH', () => {
        expect(isSafeControlCommand('')).toBe(false);
        expect(isSafeControlCommand('   ')).toBe(false);
        expect(isSafeControlCommand('\t')).toBe(false);
    });

    it('refuses an embedded newline (it would smuggle a second command, or a detach)', () => {
        expect(isSafeControlCommand('list-panes\n')).toBe(false);
        expect(isSafeControlCommand('list-panes\n\n')).toBe(false);
        expect(isSafeControlCommand('list-panes\nkill-server')).toBe(false);
        expect(isSafeControlCommand('list-panes\r')).toBe(false);
    });
});

describe('kill discipline', () => {
    it('leaves a real grace before SIGKILL (a slow tmux is not a hung tmux)', () => {
        expect(CONTROL_CLIENT_KILL_GRACE_MS).toBeGreaterThanOrEqual(1000);
        expect(CONTROL_CLIENT_KILL_GRACE_MS).toBeLessThanOrEqual(5000);
    });
});
