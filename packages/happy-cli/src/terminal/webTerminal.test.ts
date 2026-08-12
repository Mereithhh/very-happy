/**
 * Unit tests for classifyPane — the pure heuristic that maps a tmux pane's
 * foreground command + captured tail text to an AgentState for the sidebar.
 * Fixtures below approximate real Claude Code TUI frames.
 */
import { describe, it, expect } from 'vitest';
import { classifyPane, normalizeStartupCommand, startupInjectionArgs, planScrollAction, sgrWheelHexBytes } from './webTerminal';

describe('planScrollAction', () => {
    it('scrolling up from the live view enters copy-mode scroll', () => {
        expect(planScrollAction(false, false, false, 3)).toEqual({ kind: 'copy-scroll', dir: 'up', count: 3 });
    });

    it('scrolling down at the live bottom is a no-op', () => {
        expect(planScrollAction(false, false, false, -3)).toEqual({ kind: 'none' });
    });

    it('keeps scrolling copy-mode in both directions once in mode', () => {
        expect(planScrollAction(true, false, false, 5)).toEqual({ kind: 'copy-scroll', dir: 'up', count: 5 });
        expect(planScrollAction(true, false, false, -5)).toEqual({ kind: 'copy-scroll', dir: 'down', count: 5 });
    });

    it('copy-mode wins over an inner alternate screen (probing order)', () => {
        // A vim session scrolled back via copy-mode stays in copy-mode.
        expect(planScrollAction(true, true, false, -2)).toEqual({ kind: 'copy-scroll', dir: 'down', count: 2 });
        // …even when that inner app wants the mouse (Claude in copy-mode).
        expect(planScrollAction(true, true, true, 2)).toEqual({ kind: 'copy-scroll', dir: 'up', count: 2 });
    });

    it('synthesizes SGR wheel events for a fullscreen app that asked for mouse reporting (Claude Code TUI)', () => {
        // Arrow keys would walk history / move the cursor in its input box.
        expect(planScrollAction(false, true, true, 3)).toEqual({ kind: 'mouse-wheel', dir: 'up', count: 3 });
        expect(planScrollAction(false, true, true, -2)).toEqual({ kind: 'mouse-wheel', dir: 'down', count: 2 });
    });

    it('forwards arrow keys when the inner app is fullscreen WITHOUT mouse reporting (vim/less)', () => {
        expect(planScrollAction(false, true, false, 2)).toEqual({ kind: 'keys', key: 'Up', count: 2 });
        expect(planScrollAction(false, true, false, -4)).toEqual({ kind: 'keys', key: 'Down', count: 4 });
    });

    it('mouse_any_flag without alternate screen changes nothing (normal-buffer app)', () => {
        expect(planScrollAction(false, false, true, 3)).toEqual({ kind: 'copy-scroll', dir: 'up', count: 3 });
        expect(planScrollAction(false, false, true, -3)).toEqual({ kind: 'none' });
    });

    it('zero / fractional-below-one lines do nothing', () => {
        expect(planScrollAction(false, false, false, 0)).toEqual({ kind: 'none' });
        expect(planScrollAction(false, false, false, 0.9)).toEqual({ kind: 'none' });
        expect(planScrollAction(true, false, false, -0.5)).toEqual({ kind: 'none' });
    });

    it('caps a burst at 200 lines per step', () => {
        expect(planScrollAction(false, false, false, 10_000)).toEqual({ kind: 'copy-scroll', dir: 'up', count: 200 });
        expect(planScrollAction(false, true, true, 10_000)).toEqual({ kind: 'mouse-wheel', dir: 'up', count: 200 });
    });
});

describe('sgrWheelHexBytes', () => {
    const decode = (hex: string[]) => hex.map((h) => String.fromCharCode(parseInt(h, 16))).join('');

    it('encodes one WheelUp event at the pane center (SGR, 1-based)', () => {
        const hex = sgrWheelHexBytes('up', 1, 80, 24);
        expect(decode(hex)).toBe('\x1b[<64;40;12M');
    });

    it('encodes WheelDown with button 65', () => {
        expect(decode(sgrWheelHexBytes('down', 1, 80, 24))).toBe('\x1b[<65;40;12M');
    });

    it('repeats the event count times, back to back, in one byte list', () => {
        const hex = sgrWheelHexBytes('up', 3, 80, 24);
        expect(decode(hex)).toBe('\x1b[<64;40;12M'.repeat(3));
    });

    it('clamps center coordinates to at least 1 (degenerate pane sizes)', () => {
        expect(decode(sgrWheelHexBytes('up', 1, 1, 1))).toBe('\x1b[<64;1;1M');
        expect(decode(sgrWheelHexBytes('up', 1, 0, 0))).toBe('\x1b[<64;1;1M');
    });

    it('emits two-digit lowercase hex for every byte (tmux send-keys -H format)', () => {
        for (const b of sgrWheelHexBytes('up', 1, 80, 24)) {
            expect(b).toMatch(/^[0-9a-f]{2}$/);
        }
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

describe('normalizeStartupCommand', () => {
    it('accepts a plain one-liner and trims whitespace', () => {
        expect(normalizeStartupCommand('  cd ~/code && claude  ')).toBe('cd ~/code && claude');
    });

    it('rejects non-strings (old / foreign clients)', () => {
        expect(normalizeStartupCommand(undefined)).toBeUndefined();
        expect(normalizeStartupCommand(null)).toBeUndefined();
        expect(normalizeStartupCommand(42)).toBeUndefined();
        expect(normalizeStartupCommand(['rm', '-rf'])).toBeUndefined();
        expect(normalizeStartupCommand({ cmd: 'ls' })).toBeUndefined();
    });

    it('rejects blank strings — the "disabled" setting value', () => {
        expect(normalizeStartupCommand('')).toBeUndefined();
        expect(normalizeStartupCommand('   ')).toBeUndefined();
        expect(normalizeStartupCommand('\n\r\n')).toBeUndefined();
    });

    it('collapses embedded newlines to spaces (single command line semantics)', () => {
        expect(normalizeStartupCommand('cd ~/code\nclaude')).toBe('cd ~/code claude');
        expect(normalizeStartupCommand('a\r\n\r\nb')).toBe('a b');
    });

    it('rejects absurd lengths', () => {
        expect(normalizeStartupCommand('x'.repeat(2000))).toBe('x'.repeat(2000));
        expect(normalizeStartupCommand('x'.repeat(2001))).toBeUndefined();
    });

    it('keeps shell metacharacters verbatim — escaping is send-keys -l\'s job', () => {
        const cmd = `cd "$HOME/my dir" && echo 'a;b' | grep -- -v`;
        expect(normalizeStartupCommand(cmd)).toBe(cmd);
    });
});

describe('startupInjectionArgs', () => {
    it('sends the command literally, then Enter as a separate key press', () => {
        expect(startupInjectionArgs('vh-abc123', 'cd ~/x && claude')).toEqual([
            ['send-keys', '-t', '=vh-abc123:', '-l', '--', 'cd ~/x && claude'],
            ['send-keys', '-t', '=vh-abc123:', 'Enter'],
        ]);
    });

    it('passes tmux-significant content as ONE literal argv element (no parsing surface)', () => {
        // `;` would separate tmux commands, `Enter`/`C-c` are key names, `#{}`
        // is format expansion — all must ride inside the single `-l` argument.
        const nasty = `echo 'hi; kill-server' Enter C-c #{pane_id} "$(rm -rf /)"`;
        const [literal, enter] = startupInjectionArgs('vh-x', nasty);
        expect(literal).toEqual(['send-keys', '-t', '=vh-x:', '-l', '--', nasty]);
        expect(literal.filter((a) => a === nasty)).toHaveLength(1);
        // The Enter keypress must NOT be literal, or it would type the word "Enter".
        expect(enter).toEqual(['send-keys', '-t', '=vh-x:', 'Enter']);
        expect(enter).not.toContain('-l');
    });

    it('guards a command starting with "-" behind --', () => {
        const [literal] = startupInjectionArgs('vh-x', '-n hello');
        const dd = literal.indexOf('--');
        expect(dd).toBeGreaterThan(-1);
        expect(literal[dd + 1]).toBe('-n hello');
    });

    it('targets the session by exact match (= prefix), not prefix match', () => {
        for (const args of startupInjectionArgs('vh-abc', 'ls')) {
            expect(args[args.indexOf('-t') + 1]).toBe('=vh-abc:');
        }
    });
});
