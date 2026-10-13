import { describe, expect, it } from 'vitest';
import {
    generateWorktreeBranch, isAbsoluteMachinePath, markInvisibleChars, isPlausibleBranchName, isUnsupportedRpcError, machineSupportsWorktrees,
    setupBannerKind, worktreeBranchLabel, worktreeLocationFor,
} from './worktree';

describe('B-586 worktree helpers', () => {
    it('gates on the machine capability, not the CLI version', () => {
        expect(machineSupportsWorktrees({ metadata: { worktreeVersion: 1 } })).toBe(true);
        expect(machineSupportsWorktrees({ metadata: {} })).toBe(false);
        expect(machineSupportsWorktrees({ metadata: null })).toBe(false);
        expect(machineSupportsWorktrees(undefined)).toBe(false);
    });

    it('recognizes an old daemon answer', () => {
        expect(isUnsupportedRpcError('Method not found')).toBe(true);
        expect(isUnsupportedRpcError('branch-exists: x')).toBe(false);
        expect(isUnsupportedRpcError(undefined)).toBe(false);
    });

    it('generates vh/<adj>-<noun> and derives the location like the daemon', () => {
        expect(generateWorktreeBranch(() => 0)).toBe('vh/clever-ocean');
        expect(generateWorktreeBranch(() => 0.9999)).toBe('vh/fresh-desert');
        expect(worktreeLocationFor('/code/repo.worktrees', 'vh/swift-river')).toBe('/code/repo.worktrees/vh-swift-river');
        expect(worktreeLocationFor('/code/repo.worktrees/', 'feat/a b')).toBe('/code/repo.worktrees/feat-a-b');
        expect(worktreeLocationFor('C:\\code\\repo.worktrees', 'x/y')).toBe('C:\\code\\repo.worktrees\\x-y');
    });

    it('pre-checks branch names', () => {
        for (const ok of ['vh/swift-river', 'feature/x.y', 'a']) expect(isPlausibleBranchName(ok), ok).toBe(true);
        for (const bad of ['', '-x', 'a..b', 'a b', 'a~1', 'a:b', 'x/', '/x', 'x.lock', 'a@{b', 'a\\b', 'x.']) expect(isPlausibleBranchName(bad), bad).toBe(false);
    });

    it('maps setup states to strips (unknown → none)', () => {
        expect(setupBannerKind('needs-approval')).toBe('approve');
        expect(setupBannerKind('running')).toBe('running');
        for (const s of ['failed', 'timed-out', 'interrupted', 'unsupported']) expect(setupBannerKind(s)).toBe('failed');
        expect(setupBannerKind('succeeded')).toBe('succeeded');
        expect(setupBannerKind('declined')).toBe('declined');
        expect(setupBannerKind('none')).toBeNull();
        expect(setupBannerKind('future-state')).toBeNull();
    });

    it('labels the branch of a worktree session only', () => {
        expect(worktreeBranchLabel({ worktree: { branch: 'vh/a' } })).toBe('⎇ vh/a');
        expect(worktreeBranchLabel({ worktree: { branch: null } })).toBeNull();
        expect(worktreeBranchLabel({})).toBeNull();
    });

    it('absolute machine paths', () => {
        expect(isAbsoluteMachinePath('/x')).toBe(true);
        expect(isAbsoluteMachinePath('C:\\x')).toBe(true);
        expect(isAbsoluteMachinePath('~/x')).toBe(false);
        expect(isAbsoluteMachinePath('x')).toBe(false);
    });

    it('低9: marks bidi controls, zero-width chars and bare CR visibly', () => {
        const script = 'echo ok\n# \u202Eevil\u202C\nrm\u200B -rf x\r\n';
        const { segments, count } = markInvisibleChars(script);
        expect(count).toBe(4);
        expect(segments.filter((s) => s.kind === 'invisible').map((s) => (s as { code: string }).code)).toEqual(['U+202E', 'U+202C', 'U+200B', 'U+000D']);
        expect(segments.map((s) => (s.kind === 'text' ? s.text : '')).join('')).toBe('echo ok\n# evil\nrm -rf x\n');
        expect(markInvisibleChars('plain\tscript\n').count).toBe(0);
    });
});
