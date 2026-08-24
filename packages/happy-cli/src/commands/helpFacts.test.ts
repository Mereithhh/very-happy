import { describe, expect, it } from 'vitest';
import { CLAUDE_OPTIONS_HELP, DAEMON_STOP_HELP } from './helpFacts';

describe('CLI help facts', () => {
    it('does not claim every Claude option is forwarded', () => {
        expect(CLAUDE_OPTIONS_HELP).toContain('most Claude options');
        expect(CLAUDE_OPTIONS_HELP).toContain('--settings');
        expect(CLAUDE_OPTIONS_HELP).toContain('ignored with a warning');
        expect(CLAUDE_OPTIONS_HELP).not.toContain('supports all Claude options');
    });

    it('distinguishes durable tmux sessions from daemon-owned direct shells', () => {
        expect(DAEMON_STOP_HELP).toContain('tmux sessions stay alive');
        expect(DAEMON_STOP_HELP).toContain('direct-shell terminals end');
    });
});
