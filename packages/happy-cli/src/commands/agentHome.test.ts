import { describe, it, expect } from 'vitest';

import { formatAgentHomes, parseAgentHomeArgs } from './agentHome';

describe('parseAgentHomeArgs', () => {
    it('defaults to show', () => {
        expect(parseAgentHomeArgs([])).toEqual({ action: 'show' });
        expect(parseAgentHomeArgs(['--help'])).toEqual({ action: 'help' });
    });

    it('parses set and clear', () => {
        expect(parseAgentHomeArgs(['set', 'claude', '/mnt/data/.claude'])).toEqual({ action: 'set', kind: 'claude', dir: '/mnt/data/.claude' });
        expect(parseAgentHomeArgs(['set', 'codex', '~/persist/codex'])).toEqual({ action: 'set', kind: 'codex', dir: '~/persist/codex' });
        expect(parseAgentHomeArgs(['clear'])).toEqual({ action: 'clear', kind: 'both' });
        expect(parseAgentHomeArgs(['clear', 'codex'])).toEqual({ action: 'clear', kind: 'codex' });
    });

    it('rejects malformed input', () => {
        expect(() => parseAgentHomeArgs(['set', 'gemini', '/x'])).toThrow(/Usage/);
        expect(() => parseAgentHomeArgs(['set', 'claude'])).toThrow(/Usage/);
        expect(() => parseAgentHomeArgs(['clear', 'nope'])).toThrow(/Usage/);
        expect(() => parseAgentHomeArgs(['frobnicate'])).toThrow(/Unknown/);
    });
});

describe('formatAgentHomes', () => {
    it('prints both directories with their source', () => {
        expect(formatAgentHomes({
            claudeConfigDir: { path: '/mnt/data/.claude', source: 'login-shell' },
            codexHome: { path: '/home/wei/.codex', source: 'default' },
        })).toBe('Claude config dir: /mnt/data/.claude (login shell)\nCodex home:        /home/wei/.codex (default)');
    });
});
