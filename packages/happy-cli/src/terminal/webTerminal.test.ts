/**
 * Unit tests for classifyPane — the pure heuristic that maps a tmux pane's
 * foreground command + captured tail text to an AgentState for the sidebar.
 * Fixtures below approximate real Claude Code TUI frames.
 */
import { describe, it, expect } from 'vitest';
import { parseLayoutSize, geometryMarker, GEOMETRY_OSC_CODE, classifyPane, normalizeStartupCommand, startupInjectionArgs, planScrollAction, sgrWheelHexBytes, deriveAutoTitle, parseSessionListLine, LIST_FIELD_SEP, looksLikeClaudeCommand, tmuxSupportsNewSessionEnv, CLAUDE_CLASSIC_RENDERER_ENV, terminalListSignature, ACTIVITY_SIGNATURE_BUCKET_MS, pruneTombstones, diffTerminalActivity, type TerminalListItem } from './webTerminal';

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

    it('sends PageUp/PageDown for a fullscreen CLAUDE without mouse reporting (arrows would open its prompt-history browser)', () => {
        // Verified on claude 2.1.228 + CLAUDE_CODE_DISABLE_MOUSE=1: Up/Down
        // open "History n/n"; PageUp scrolls the transcript half a screen.
        expect(planScrollAction(false, true, false, 3, true, 30)).toEqual({ kind: 'page-keys', key: 'PPage', count: 1 });
        expect(planScrollAction(false, true, false, -3, true, 30)).toEqual({ kind: 'page-keys', key: 'NPage', count: 1 });
    });

    it('converts lines to half-viewport pages, at least one', () => {
        // 30-row pane → half page = 15 lines; 45 lines ≈ 3 pages, 1 line → 1 page.
        expect(planScrollAction(false, true, false, 45, true, 30)).toEqual({ kind: 'page-keys', key: 'PPage', count: 3 });
        expect(planScrollAction(false, true, false, 1, true, 30)).toEqual({ kind: 'page-keys', key: 'PPage', count: 1 });
        // Degenerate pane heights never divide by zero.
        expect(planScrollAction(false, true, false, 5, true, 0)).toEqual({ kind: 'page-keys', key: 'PPage', count: 5 });
    });

    it('claude WITH mouse reporting still gets synthetic wheel events, not PageUp', () => {
        expect(planScrollAction(false, true, true, 3, true, 30)).toEqual({ kind: 'mouse-wheel', dir: 'up', count: 3 });
    });

    it('classic-renderer claude (no alternate screen) takes the copy-mode path — its transcript lives in tmux history', () => {
        expect(planScrollAction(false, false, false, 3, true, 30)).toEqual({ kind: 'copy-scroll', dir: 'up', count: 3 });
        expect(planScrollAction(false, false, false, -3, true, 30)).toEqual({ kind: 'none' });
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

describe('looksLikeClaudeCommand', () => {
    it('matches claude, node (bundled CLI) and bare version strings (argv0 quirk)', () => {
        expect(looksLikeClaudeCommand('claude')).toBe(true);
        expect(looksLikeClaudeCommand('node')).toBe(true);
        expect(looksLikeClaudeCommand('2.1.228')).toBe(true);
        expect(looksLikeClaudeCommand('2.1')).toBe(true);
    });

    it('normalizes login-shell dashes, case and whitespace', () => {
        expect(looksLikeClaudeCommand('-claude')).toBe(true);
        expect(looksLikeClaudeCommand('  Claude ')).toBe(true);
    });

    it('rejects shells and fullscreen apps that must keep arrow-key scrolling', () => {
        for (const cmd of ['zsh', '-zsh', 'bash', 'vim', 'less', 'htop', '', 'python3.12']) {
            expect(looksLikeClaudeCommand(cmd)).toBe(false);
        }
    });
});

describe('tmuxSupportsNewSessionEnv', () => {
    it('accepts tmux ≥3.2 (new-session -e)', () => {
        expect(tmuxSupportsNewSessionEnv('tmux 3.2')).toBe(true);
        expect(tmuxSupportsNewSessionEnv('tmux 3.2a')).toBe(true);
        expect(tmuxSupportsNewSessionEnv('tmux 3.6b')).toBe(true);
        expect(tmuxSupportsNewSessionEnv('tmux next-3.7')).toBe(true);
        expect(tmuxSupportsNewSessionEnv('tmux master')).toBe(true);
    });

    it('rejects older tmux and unparseable output (unknown -e would fail the create)', () => {
        expect(tmuxSupportsNewSessionEnv('tmux 3.1c')).toBe(false);
        expect(tmuxSupportsNewSessionEnv('tmux 2.9a')).toBe(false);
        expect(tmuxSupportsNewSessionEnv('')).toBe(false);
        expect(tmuxSupportsNewSessionEnv('garbage')).toBe(false);
    });
});

describe('CLAUDE_CLASSIC_RENDERER_ENV', () => {
    it('is a single VAR=value token with no shell metacharacters (inlined into the pty script)', () => {
        expect(CLAUDE_CLASSIC_RENDERER_ENV).toMatch(/^[A-Z_]+=[A-Za-z0-9_]+$/);
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
    'demo@dev-laptop ~/code/github/very-happy % ls',
    'README.md  packages  pnpm-lock.yaml',
    'demo@dev-laptop ~/code/github/very-happy %',
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
        expect(classifyPane('fish', 'demo@host ~> ')).toBe('shell');
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

describe('deriveAutoTitle', () => {
    const HOST = 'dev-laptop.local';

    it('strips Claude Code status glyph prefixes (spinner set varies by version)', () => {
        // Real pane_title values observed on tmux 3.6b with claude running.
        expect(deriveAutoTitle('✳ 与ted沟通GPU成本口径', HOST)).toBe('与ted沟通GPU成本口径');
        expect(deriveAutoTitle('◐ webhook-integration-setup', HOST)).toBe('webhook-integration-setup');
        expect(deriveAutoTitle('✶ · Fix build', HOST)).toBe('Fix build');
    });

    it('drops the tmux default pane title: the hostname, full or short form', () => {
        expect(deriveAutoTitle('dev-laptop.local', HOST)).toBeUndefined();
        expect(deriveAutoTitle('dev-laptop', HOST)).toBeUndefined();     // short form
        expect(deriveAutoTitle('DEV-LAPTOP', HOST)).toBeUndefined();     // case-insensitive
        expect(deriveAutoTitle('dev-laptop-2', HOST)).toBe('dev-laptop-2'); // different host: keep
    });

    it('drops bare process names that say nothing', () => {
        for (const junk of ['zsh', 'bash', 'claude', 'node', 'tmux', 'Claude']) {
            expect(deriveAutoTitle(junk, HOST)).toBeUndefined();
        }
    });

    it('drops empty / glyph-only / non-string values', () => {
        expect(deriveAutoTitle('', HOST)).toBeUndefined();
        expect(deriveAutoTitle('   ', HOST)).toBeUndefined();
        expect(deriveAutoTitle('✳ ', HOST)).toBeUndefined();
        expect(deriveAutoTitle(undefined, HOST)).toBeUndefined();
        expect(deriveAutoTitle(42, HOST)).toBeUndefined();
    });

    it('collapses whitespace and truncates to 60 code points (CJK-safe)', () => {
        expect(deriveAutoTitle('fix   the\t build', HOST)).toBe('fix the build');
        const long = '任'.repeat(80);
        expect(deriveAutoTitle(long, HOST)).toBe('任'.repeat(60));
        expect(deriveAutoTitle('x'.repeat(60), HOST)).toBe('x'.repeat(60)); // exactly at cap: untouched
    });

    it('keeps meaningful shell-set titles (e.g. "dir: cmd" style)', () => {
        expect(deriveAutoTitle('~/code: vim foo.ts', HOST)).toBe('code: vim foo.ts');
    });
});

describe('terminalListSignature', () => {
    const item = (over: Partial<TerminalListItem> = {}): TerminalListItem => ({
        id: 'a', title: 'T', cwd: '/x', createdAt: 1000, activityAt: 5000, agentState: 'idle', ...over,
    });

    it('is stable for identical lists and insensitive to order', () => {
        const a = [item({ id: 'a' }), item({ id: 'b' })];
        const b = [item({ id: 'b' }), item({ id: 'a' })];
        expect(terminalListSignature(a)).toBe(terminalListSignature(b));
    });

    it('changes on membership, title, cwd and agentState changes', () => {
        const base = terminalListSignature([item()]);
        expect(terminalListSignature([])).not.toBe(base);
        expect(terminalListSignature([item(), item({ id: 'b' })])).not.toBe(base);
        expect(terminalListSignature([item({ title: 'other' })])).not.toBe(base);
        expect(terminalListSignature([item({ cwd: '/y' })])).not.toBe(base);
        expect(terminalListSignature([item({ agentState: 'working' })])).not.toBe(base);
        expect(terminalListSignature([item({ agentState: undefined })])).not.toBe(base);
    });

    it('changes when a mirror binding appears or disappears (B-105 toggle push)', () => {
        const base = terminalListSignature([item()]);
        const bound = terminalListSignature([item({ mirrorSessionId: 'mirror-1' })]);
        expect(bound).not.toBe(base);
        expect(terminalListSignature([item({ mirrorSessionId: 'mirror-2' })])).not.toBe(bound);
    });

    it('quantizes activityAt: within one bucket no change, across buckets change', () => {
        const t0 = 10 * ACTIVITY_SIGNATURE_BUCKET_MS;
        const base = terminalListSignature([item({ activityAt: t0 })]);
        // Continuous output inside the same minute must NOT re-push.
        expect(terminalListSignature([item({ activityAt: t0 + ACTIVITY_SIGNATURE_BUCKET_MS - 1 })])).toBe(base);
        // Crossing the bucket boundary is a change (at most one push a minute).
        expect(terminalListSignature([item({ activityAt: t0 + ACTIVITY_SIGNATURE_BUCKET_MS })])).not.toBe(base);
    });

    it('treats absent optional fields consistently (undefined == missing)', () => {
        const explicit: TerminalListItem = { id: 'a', title: undefined, cwd: undefined, createdAt: undefined, activityAt: undefined, agentState: undefined };
        const bare: TerminalListItem = { id: 'a' };
        expect(terminalListSignature([explicit])).toBe(terminalListSignature([bare]));
    });

    it('does not confuse field boundaries (title vs cwd)', () => {
        expect(terminalListSignature([item({ title: 'ab', cwd: 'c' })]))
            .not.toBe(terminalListSignature([item({ title: 'a', cwd: 'bc' })]));
    });
});

describe('parseSessionListLine', () => {
    const mk = (...fields: string[]) => fields.join(LIST_FIELD_SEP);

    it('parses a full line (epoch seconds → ms, trims titles)', () => {
        const line = mk('vh-abc', '1700000000', '1700000100', '/Users/x/code', ' my title ', '1', 'node', '✳ task');
        expect(parseSessionListLine(line)).toEqual({
            name: 'vh-abc',
            created: 1700000000000,
            activity: 1700000100000,
            cwd: '/Users/x/code',
            vhTitle: 'my title',
            manual: true,
            paneCurrentCommand: 'node',
            paneTitle: '✳ task',
        });
    });

    it('empty optional fields become undefined / manual=false', () => {
        const line = mk('vh-abc', '', '', '', '', '', '', '');
        expect(parseSessionListLine(line)).toEqual({
            name: 'vh-abc',
            created: undefined,
            activity: undefined,
            cwd: undefined,
            vhTitle: undefined,
            manual: false,
            paneCurrentCommand: undefined,
            paneTitle: undefined,
        });
    });

    it('rejects blank or malformed lines instead of guessing', () => {
        expect(parseSessionListLine('')).toBeUndefined();
        expect(parseSessionListLine('vh-abc\t123')).toBeUndefined();          // old tab format
        expect(parseSessionListLine(mk('vh-abc', '1', '2', '/x'))).toBeUndefined(); // too few fields
        // B-121: the 7-field (pre pane_current_command) shape is now malformed
        // — daemon and format ship together, so a short line means a garbled
        // read, not an old daemon.
        expect(parseSessionListLine(mk('vh-abc', '1', '2', '/x', '', '', 't'))).toBeUndefined();
        expect(parseSessionListLine(mk('', '1', '2', '/x', '', '', 'zsh', 't'))).toBeUndefined(); // no name
    });

    it('a pathological separator inside pane_title only garbles the title, never the fields', () => {
        const line = mk('vh-abc', '1', '2', '/x', 'v', '', 'zsh', `weird${LIST_FIELD_SEP}title`);
        const parsed = parseSessionListLine(line)!;
        expect(parsed.name).toBe('vh-abc');
        expect(parsed.cwd).toBe('/x');
        expect(parsed.paneCurrentCommand).toBe('zsh');
        expect(parsed.paneTitle).toBe(`weird${LIST_FIELD_SEP}title`);
    });

    it('pane_current_command sits BEFORE pane_title (a title with a separator cannot shift it)', () => {
        // The whole reason for the field order: if the command were last, a
        // title containing 0x1f would silently steal it.
        const line = mk('vh-abc', '1', '2', '/x', '', '', '2.1.228', `a${LIST_FIELD_SEP}b`);
        expect(parseSessionListLine(line)!.paneCurrentCommand).toBe('2.1.228');
    });
});

describe('pruneTombstones', () => {
    it('keeps fresh, drops expired and malformed entries', () => {
        const now = 1_700_000_000_000;
        const week = 7 * 24 * 60 * 60 * 1000;
        const out = pruneTombstones(
            {
                fresh: now - 1000,
                edge: now - week + 1,
                expired: now - week,
                junk: 'nope' as unknown as number,
            },
            now,
        );
        expect(Object.keys(out).sort()).toEqual(['edge', 'fresh']);
    });

    it('empty in, empty out', () => {
        expect(pruneTombstones({}, Date.now())).toEqual({});
    });
});

describe('diffTerminalActivity', () => {
    it('reports every id on a cold start', () => {
        expect(diffTerminalActivity({}, { a: 100, b: 200 }))
            .toEqual([{ id: 'a', activityAt: 100 }, { id: 'b', activityAt: 200 }]);
    });

    it('reports ONLY forward moves — an unchanged map costs zero traffic', () => {
        expect(diffTerminalActivity({ a: 100, b: 200 }, { a: 100, b: 200 })).toEqual([]);
        expect(diffTerminalActivity({ a: 100, b: 200 }, { a: 101, b: 200 }))
            .toEqual([{ id: 'a', activityAt: 101 }]);
    });

    it('never reports a BACKWARD move', () => {
        // The tmux poll can legitimately return an older #{session_activity}
        // than the live pty already told us; un-floating the row would be a lie.
        expect(diffTerminalActivity({ a: 5000 }, { a: 1000 })).toEqual([]);
    });

    it('ignores junk stamps', () => {
        expect(diffTerminalActivity({}, { a: 0, b: -1, c: NaN, d: Infinity })).toEqual([]);
    });

    it('ignores ids that vanished from the current map', () => {
        expect(diffTerminalActivity({ gone: 100 }, {})).toEqual([]);
    });

    it('does not mutate its inputs', () => {
        const last = { a: 1 };
        const cur = { a: 2 };
        diffTerminalActivity(last, cur);
        expect(last).toEqual({ a: 1 });
        expect(cur).toEqual({ a: 2 });
    });
});

describe('parseLayoutSize (B-121: follow a LOCAL tmux client\'s resize)', () => {
    it('reads the window size out of a %layout-change payload', () => {
        expect(parseLayoutSize('@0 b25d,80x24,0,0,0 b25d,80x24,0,0,0 *')).toEqual({ cols: 80, rows: 24 });
        expect(parseLayoutSize('@195 2ce9,127x40,0,0,195 2ce9,127x40,0,0,195 *')).toEqual({ cols: 127, rows: 40 });
    });

    it('follows the FIRST pane in a split window (single-pane declaration)', () => {
        // A split window nests each pane's own size; the window's own WxH is not
        // what the pane we mirror is wrapped at.
        expect(parseLayoutSize('@0 abcd,80x24,0,0{80x12,0,0,1,80x11,0,13,2}')).toEqual({ cols: 80, rows: 12 });
        expect(parseLayoutSize('@0 abcd,200x50,0,0[200x25,0,0,3,200x24,0,26,4]')).toEqual({ cols: 200, rows: 25 });
    });

    it('returns undefined rather than guessing (a wrong resize is worse than none)', () => {
        expect(parseLayoutSize('')).toBeUndefined();
        expect(parseLayoutSize('@0 nosize')).toBeUndefined();
        expect(parseLayoutSize('@0 aaaa,1x1,0,0,0')).toBeUndefined(); // below the 2x2 floor
    });
});

describe('geometryMarker (B-124: in-band pane geometry)', () => {
    it('is a private OSC carrying cols;rows', () => {
        expect(geometryMarker(120, 40).toString('ascii')).toBe(`\x1b]${GEOMETRY_OSC_CODE};120;40\x07`);
    });

    it('clamps degenerate sizes instead of emitting them', () => {
        expect(geometryMarker(0, -3).toString('ascii')).toBe(`\x1b]${GEOMETRY_OSC_CODE};2;2\x07`);
        expect(geometryMarker(80.7, 24.9).toString('ascii')).toBe(`\x1b]${GEOMETRY_OSC_CODE};80;24\x07`);
    });

    it('is inert for anyone who does not know it (unknown OSC = ignored)', () => {
        // The whole point of picking an OSC: an old web, the daemon's own
        // headless, and `cat`ting the stream all just drop it.
        const s = geometryMarker(100, 30).toString('ascii');
        expect(s.startsWith('\x1b]')).toBe(true);
        expect(s.endsWith('\x07')).toBe(true);
        expect(s).not.toMatch(/[\r\n]/);
    });
});
