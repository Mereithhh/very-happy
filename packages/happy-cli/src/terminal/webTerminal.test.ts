/**
 * Unit tests for classifyPane — the pure heuristic that maps a tmux pane's
 * foreground command + captured tail text to an AgentState for the sidebar.
 * Fixtures below approximate real Claude Code TUI frames.
 */
import { describe, it, expect } from 'vitest';
import { classifyPane, planScrollAction } from './webTerminal';

describe('planScrollAction', () => {
    it('scrolling up from the live view enters copy-mode scroll', () => {
        expect(planScrollAction(false, false, 3)).toEqual({ kind: 'copy-scroll', dir: 'up', count: 3 });
    });

    it('scrolling down at the live bottom is a no-op', () => {
        expect(planScrollAction(false, false, -3)).toEqual({ kind: 'none' });
    });

    it('keeps scrolling copy-mode in both directions once in mode', () => {
        expect(planScrollAction(true, false, 5)).toEqual({ kind: 'copy-scroll', dir: 'up', count: 5 });
        expect(planScrollAction(true, false, -5)).toEqual({ kind: 'copy-scroll', dir: 'down', count: 5 });
    });

    it('copy-mode wins over an inner alternate screen (probing order)', () => {
        // A vim session scrolled back via copy-mode stays in copy-mode.
        expect(planScrollAction(true, true, -2)).toEqual({ kind: 'copy-scroll', dir: 'down', count: 2 });
    });

    it('forwards arrow keys when the inner app is fullscreen (vim/less)', () => {
        expect(planScrollAction(false, true, 2)).toEqual({ kind: 'keys', key: 'Up', count: 2 });
        expect(planScrollAction(false, true, -4)).toEqual({ kind: 'keys', key: 'Down', count: 4 });
    });

    it('zero / fractional-below-one lines do nothing', () => {
        expect(planScrollAction(false, false, 0)).toEqual({ kind: 'none' });
        expect(planScrollAction(false, false, 0.9)).toEqual({ kind: 'none' });
        expect(planScrollAction(true, false, -0.5)).toEqual({ kind: 'none' });
    });

    it('caps a burst at 200 lines per step', () => {
        expect(planScrollAction(false, false, 10_000)).toEqual({ kind: 'copy-scroll', dir: 'up', count: 200 });
    });
});

const WORKING_FOOTER = [
    '⏺ Searching for the config loader…',
    '',
    '· Flibbertigibbeting… (esc to interrupt)',
    '',
    '  ⎿  Running: grep -rn "loadConfig" src/',
].join('\n');

const PERMISSION_DIALOG = [
    '╭──────────────────────────────────────────────────────╮',
    '│ Bash command                                         │',
    '│                                                      │',
    '│   rm -rf node_modules                                │',
    '│   Remove installed dependencies                      │',
    '│                                                      │',
    '│ Do you want to proceed?                              │',
    '│ ❯ 1. Yes                                             │',
    '│   2. Yes, and don\'t ask again this session           │',
    '│   3. No, and tell Claude what to do differently      │',
    '╰──────────────────────────────────────────────────────╯',
].join('\n');

const PLAN_APPROVAL = [
    '│ Here is the plan:                                    │',
    '│  1. Add the field                                    │',
    '│  2. Write tests                                      │',
    '│                                                      │',
    '│ Would you like to proceed?                           │',
    '│ > 1. Yes, and auto-accept edits                      │',
    '│   2. Yes, and manually approve edits                 │',
    '│   3. No, keep planning                               │',
].join('\n');

const IDLE_INPUT_BOX = [
    '⏺ Done! The build passes.',
    '',
    '╭──────────────────────────────────────────────────────╮',
    '│ >                                                    │',
    '╰──────────────────────────────────────────────────────╯',
    '  ? for shortcuts                                       ',
].join('\n');

const SHELL_PROMPT = [
    'jojo@mac-office ~/code/github/very-happy % ls',
    'README.md  packages  pnpm-lock.yaml',
    'jojo@mac-office ~/code/github/very-happy %',
].join('\n');

describe('classifyPane', () => {
    it('detects working from the "esc to interrupt" footer', () => {
        expect(classifyPane('node', WORKING_FOOTER)).toBe('working');
        expect(classifyPane('claude', WORKING_FOOTER)).toBe('working');
    });

    it('detects needs_input from a permission dialog', () => {
        expect(classifyPane('node', PERMISSION_DIALOG)).toBe('needs_input');
    });

    it('detects needs_input from a plan approval with "> 1." options', () => {
        expect(classifyPane('claude', PLAN_APPROVAL)).toBe('needs_input');
    });

    it('detects needs_input from a (y/n) prompt', () => {
        expect(classifyPane('node', 'Overwrite existing file? (y/n)')).toBe('needs_input');
    });

    it('prioritizes needs_input over working when both markers show', () => {
        expect(classifyPane('node', `${WORKING_FOOTER}\n${PERMISSION_DIALOG}`)).toBe('needs_input');
    });

    it('detects idle from the input-box footer', () => {
        expect(classifyPane('node', IDLE_INPUT_BOX)).toBe('idle');
    });

    it('detects idle from claude/node foreground even without footer text', () => {
        expect(classifyPane('claude', 'some scrolled output with no markers')).toBe('idle');
        expect(classifyPane('node', '')).toBe('idle');
    });

    it('detects idle from the ⏵⏵ / bypass permissions footer', () => {
        expect(classifyPane('node', '  ⏵⏵ bypass permissions on (shift+tab to cycle)')).toBe('idle');
    });

    it('classifies a plain shell prompt as shell', () => {
        expect(classifyPane('zsh', SHELL_PROMPT)).toBe('shell');
        expect(classifyPane('bash', SHELL_PROMPT)).toBe('shell');
        expect(classifyPane('fish', 'jojo@host ~> ')).toBe('shell');
        expect(classifyPane('-zsh', SHELL_PROMPT)).toBe('shell'); // login shell
    });

    it('ignores "Do you want" quoted outside the last 15 lines', () => {
        const old = 'Do you want to proceed?';
        const padding = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n');
        expect(classifyPane('zsh', `${old}\n${padding}`)).toBe('shell');
    });

    it('trailing blank lines do not shield a dialog from the 15-line window', () => {
        const blanks = '\n'.repeat(20);
        expect(classifyPane('node', `${PERMISSION_DIALOG}${blanks}`)).toBe('needs_input');
    });

    it('does not misread a "❯" shell prompt as a choice list', () => {
        expect(classifyPane('zsh', '~/code ❯ git status\nnothing to commit\n~/code ❯')).toBe('shell');
    });

    it('returns undefined for unrecognized foreground commands', () => {
        expect(classifyPane('vim', ':wq')).toBeUndefined();
        expect(classifyPane('htop', 'CPU 12%')).toBeUndefined();
        expect(classifyPane('', '')).toBeUndefined();
    });
});
