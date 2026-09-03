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

describe('B-334 startup command selection', () => {
    it('carries the selection id and never a command line', () => {
        expect(newTerminalSearch('abc', { startupSelectionId: 'a1b2c3' }).get('cmd')).toBe('a1b2c3');
        expect(newTerminalSearch('abc', { startupSelectionId: 'none' }).get('cmd')).toBe('none');
        // Anything command-shaped is dropped by the id guard, so a caller
        // passing text by mistake cannot put it in a shareable URL.
        expect(newTerminalSearch('abc', { startupSelectionId: 'claude --resume' }).has('cmd')).toBe(false);
    });
    it('omits the default selection so an unchanged flow yields the old URL', () => {
        expect(newTerminalSearch('abc', { startupSelectionId: 'default' }).toString()).toBe('tid=abc&fresh=1');
        expect(newTerminalSearch('abc', { startupSelectionId: undefined }).toString()).toBe('tid=abc&fresh=1');
    });
    it('yields to resume and to attach, which both decide the command themselves', () => {
        const resume = newTerminalSearch('abc', { startupSelectionId: 'a1b2c3', resumeClaudeSessionId: 'c0c26854-5e0c-4063-aaeb-d4428fe8ed94' });
        expect(resume.has('cmd')).toBe(false);
        const attach = newTerminalSearch('abc', { startupSelectionId: 'a1b2c3', attachTmux: { id: '$3', name: 'dev' } });
        expect(attach.has('cmd')).toBe(false);
    });
    it('keeps the selection when the resume id is invalid (nothing overrode it)', () => {
        expect(newTerminalSearch('abc', { startupSelectionId: 'a1b2c3', resumeClaudeSessionId: '../x' }).get('cmd')).toBe('a1b2c3');
    });
});
