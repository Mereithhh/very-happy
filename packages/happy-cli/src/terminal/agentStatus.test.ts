import { describe, expect, it } from 'vitest';
import { classifyAgentPane } from './agentStatus';

// Pi 0.84.4 standard editor: captured from an isolated --no-session startup;
// selectors/spinners follow its installed status-indicator/extension-selector.
const piEditor = '\n────────────────────\n\n────────────────────\n~/repo\n0.0%/262k (auto)    model • medium';
describe('agent-specific terminal observations', () => {
    it.each([
        ['claude', '  ? for shortcuts', 'idle'],
        ['claude', '· Working… (esc to interrupt)', 'working'],
        ['claude', 'Do you want to proceed?\n❯ 1. Yes\n  2. No', 'needs_input'],
        ['codex', '› Explain this code\n  100% context left · ? for shortcuts', 'idle'],
        ['codex', '• Working (3s • esc to interrupt)', 'working'],
        ['codex', 'Would you like to run the following command?\n› 1. Yes, proceed\n  2. No', 'needs_input'],
        ['pi', piEditor, 'idle'],
        ['pi', '⠹ Working...' + piEditor, 'working'],
        ['pi', '⠼ Retrying (1/3) in 5s... (esc to cancel)' + piEditor, 'working'],
        ['pi', 'Approve tool?\n→ Allow once\n  Deny\n↑↓ navigate  enter select  esc cancel', 'needs_input'],
    ])('%s maps its own visible state to %s', (agent, screen, state) => {
        expect(classifyAgentPane(agent, screen)).toEqual({ agentKind: agent, agentState: state });
    });
    it('does not confuse Pi startup help with running work', () => {
        expect(classifyAgentPane('pi', 'pi v0.84.4\nesc to interrupt' + piEditor).agentState).toBe('idle');
    });
    it('custom/unobservable screens stay unknown', () => {
        expect(classifyAgentPane('pi', '⠹ Custom operation' + piEditor).agentState).toBeUndefined();
        expect(classifyAgentPane('codex', 'some output')).toEqual({ agentKind: 'codex', agentState: undefined });
        expect(classifyAgentPane('node', 'server running (y/n)')).toEqual({});
    });
    it('a shell retaining an agent screen is still a shell', () => {
        expect(classifyAgentPane('-zsh', 'OpenAI Codex\nWorking (esc to interrupt)')).toEqual({ agentState: 'shell' });
    });
    it('normalizes an absolute executable path and ignores old output', () => {
        expect(classifyAgentPane('/opt/bin/codex', 'Working (esc to interrupt)\n' + '\nline'.repeat(20))).toEqual({ agentKind:'codex', agentState:undefined });
    });
    it('does not identify a Pi process as Claude because model prose mentions Claude', () => {
        expect(classifyAgentPane('pi', 'tell Claude what to do' + piEditor).agentKind).toBe('pi');
    });
});
