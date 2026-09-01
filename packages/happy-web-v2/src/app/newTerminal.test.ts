import { describe, expect, it } from 'vitest';
import { newTerminalSearch } from './newTerminalSearch';

describe('B-273 newTerminalSearch', () => {
    it('plain create carries tid/fresh and optional cwd/resume (uuid only)', () => {
        expect(newTerminalSearch('abc').toString()).toBe('tid=abc&fresh=1');
        expect(newTerminalSearch('abc', { cwd: '/w' }).get('cwd')).toBe('/w');
        expect(newTerminalSearch('abc', { resumeClaudeSessionId: 'c0c26854-5e0c-4063-aaeb-d4428fe8ed94' }).get('resume')).toBe('c0c26854-5e0c-4063-aaeb-d4428fe8ed94');
        expect(newTerminalSearch('abc', { resumeClaudeSessionId: '../x' }).has('resume')).toBe(false);
    });
    it('attach carries only the tmux session id + name, and overrides cwd/resume', () => {
        const q = newTerminalSearch('abc', { cwd: '/w', resumeClaudeSessionId: 'c0c26854-5e0c-4063-aaeb-d4428fe8ed94', attachTmux: { id: '$3', name: 'my dev' } });
        expect(q.get('attach')).toBe('$3');
        expect(q.get('attachName')).toBe('my dev');
        expect(q.has('cwd')).toBe(false);
        expect(q.has('resume')).toBe(false);
        expect(q.toString()).toBe('tid=abc&fresh=1&attach=%243&attachName=my+dev');
    });
});
