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

describe('real installed agent screen regressions', () => {
    it('recognizes Pi 0.84.4 decimal-million context footer', () => {
        expect(classifyAgentPane('pi', piEditor.replace('262k','1.0M'))).toEqual({agentKind:'pi',agentState:'idle'});
    });
    it('recognizes the actual Pi model picker even when the selection is above the status footer', () => {
        expect(classifyAgentPane('pi', '→ glm-5.3 [zai]\n' + '  model\n'.repeat(20) + 'Enter to select · Ctrl+S to set as default · Esc to cancel')).toEqual({agentKind:'pi',agentState:'needs_input'});
    });
    it('recognizes the current Codex footer with hidden context percentage', () => {
        expect(classifyAgentPane('codex', '› Ask Codex to do anything\n  gpt-6-astra medium fast · ~/repo')).toEqual({agentKind:'codex',agentState:'idle'});
        expect(classifyAgentPane('codex', '• Working (0s • esc to interrupt)\n› Ask Codex to do anything\n  gpt-6-astra medium fast · ~/repo').agentState).toBe('working');
    });
});

it('detects the actual Claude Chinese AskUserQuestion selector without English Yes', () => {
    expect(classifyAgentPane('2.1.267', '你倾向选择哪个方案？\n❯ 1. 选项 A\n  2. 选项 B\nEnter to select · ↑/↓ to navigate · Esc to cancel')).toEqual({agentKind:'claude',agentState:'needs_input'});
});

 it.each(['claude', 'codex'])('keeps %s waiting when approval selection moves to another option', agent => {
    expect(classifyAgentPane(agent, 'Would you like to proceed?\n  1. Yes\n› 2. No\nEnter to select · Esc to cancel').agentState).toBe('needs_input');
 });
