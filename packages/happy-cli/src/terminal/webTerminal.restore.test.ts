/**
 * B-265 restore-terminal against a REAL tmux server (private socket via
 * src/testing/isolatedTmux.ts) and an isolated HAPPY_HOME_DIR — both set before
 * importing webTerminal (configuration is an import-time singleton).
 *
 * Asserted: a closed terminal comes back with the SAME id, cwd, title (+manual
 * flag), tags and a `claude --resume` for the recorded conversation; the call
 * is idempotent; invalid ids / unknown records / missing cwd are refused; the
 * tombstone is left alone.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIsolatedTmux, tmuxAvailable } from '@/testing/isolatedTmux';

const happyHome = mkdtempSync(join(tmpdir(), 'vh-rt-home-'));
const iso = createIsolatedTmux('vh-rt-tmux');
const workDir = mkdtempSync(join(tmpdir(), 'vh-rt-work-'));
const binDir = mkdtempSync(join(tmpdir(), 'vh-rt-bin-'));
const prevHome = process.env.HAPPY_HOME_DIR;
const prevPath = process.env.PATH;
process.env.HAPPY_HOME_DIR = happyHome;
const fakeClaude = join(binDir, 'claude');
writeFileSync(fakeClaude, '#!/bin/sh\nwhile :; do sleep 3600; done\n');
chmodSync(fakeClaude, 0o755);
process.env.PATH = `${binDir}:${prevPath ?? ''}`;

const WITH_CONV = 'rtconv001';
const NO_JSONL = 'rtnojsonl1';
const GONEDIR = 'rtgone001';
const UUID_A = 'c0c26854-5e0c-4063-aaeb-d4428fe8ed94';
const UUID_B = '11111111-2222-3333-4444-555555555555';
const NOW = Date.now();

// The claude project dir for workDir: ~/.claude/projects/<encoded cwd>/<uuid>.jsonl
const { getProjectPath } = await import('@/claude/utils/path');
mkdirSync(getProjectPath(workDir), { recursive: true });
writeFileSync(join(getProjectPath(workDir), `${UUID_A}.jsonl`), '{}\n');

writeFileSync(join(happyHome, 'closed-terminals.json'), JSON.stringify([
    { id: WITH_CONV, title: 'renamed by me', manual: true, tags: ['infra', 'p1'], cwd: workDir, claudeSessionId: UUID_A, reason: 'closed', closedAt: NOW - 1000 },
    { id: NO_JSONL, title: 'auto title', cwd: workDir, claudeSessionId: UUID_B, reason: 'closed', closedAt: NOW - 2000 },
    { id: GONEDIR, title: 'moved', cwd: join(tmpdir(), 'vh-rt-deleted-nope'), reason: 'closed', closedAt: NOW - 3000 },
]));
writeFileSync(join(happyHome, 'terminal-tombstones.json'), JSON.stringify({ [WITH_CONV]: NOW - 1000 }));

const { WebTerminalManager } = await import('./webTerminal');
const tmux = (...args: string[]) => iso.run(...args);
const sessionExists = (id: string) => tmux('has-session', '-t', `=vh-${id}:`).status === 0;
const opt = (id: string, name: string) => tmux('display-message', '-p', '-t', `=vh-${id}:`, `#{${name}}`).stdout.trim();

describe.skipIf(!tmuxAvailable)('restore-terminal (B-265, real tmux)', () => {
    const mgr = new WebTerminalManager(() => { /* stream not under test */ });

    afterAll(() => {
        mgr.stopListTracking();
        for (const id of [WITH_CONV, NO_JSONL, GONEDIR]) tmux('kill-session', '-t', `=vh-${id}:`);
        iso.dispose();
        for (const d of [happyHome, workDir, binDir]) rmSync(d, { recursive: true, force: true });
        if (prevHome === undefined) delete process.env.HAPPY_HOME_DIR; else process.env.HAPPY_HOME_DIR = prevHome;
        if (prevPath === undefined) delete process.env.PATH; else process.env.PATH = prevPath;
    });

    it('recreates the same id in the same cwd with title, manual flag, tags and the resume command', async () => {
        expect(sessionExists(WITH_CONV)).toBe(false);
        const result = mgr.restoreClosedTerminal(WITH_CONV);
        expect(result).toEqual({ type: 'success', terminalId: WITH_CONV });
        expect(sessionExists(WITH_CONV)).toBe(true);
        expect(realpathSync(opt(WITH_CONV, 'pane_current_path'))).toBe(realpathSync(workDir));
        expect(opt(WITH_CONV, '@vh_title')).toBe('renamed by me');
        expect(opt(WITH_CONV, '@vh_title_manual')).toBe('1');
        expect(JSON.parse(opt(WITH_CONV, '@vh_tags'))).toEqual(['infra', 'p1']);
        expect(tmux('show-environment', '-t', `=vh-${WITH_CONV}:`, 'VH_TERMINAL_ID').stdout.trim()).toBe(`VH_TERMINAL_ID=${WITH_CONV}`);
        await new Promise((r) => setTimeout(r, 300));
        expect(tmux('capture-pane', '-p', '-S', '-', '-t', `=vh-${WITH_CONV}:`).stdout).toContain(`claude --resume ${UUID_A}`);
    });

    it('is idempotent and keeps the tombstone (a live tmux attaches regardless)', () => {
        expect(mgr.restoreClosedTerminal(WITH_CONV)).toEqual({ type: 'success', terminalId: WITH_CONV });
        const names = tmux('list-sessions', '-F', '#{session_name}').stdout.split('\n').filter(Boolean);
        expect(names.filter((n) => n === `vh-${WITH_CONV}`)).toHaveLength(1);
        const tombstones = JSON.parse(require('node:fs').readFileSync(join(happyHome, 'terminal-tombstones.json'), 'utf8'));
        expect(tombstones[WITH_CONV]).toBeDefined();
    });

    it('recreates without a resume command when the conversation file is gone, and never marks an auto title manual', () => {
        expect(mgr.restoreClosedTerminal(NO_JSONL)).toEqual({ type: 'success', terminalId: NO_JSONL });
        expect(opt(NO_JSONL, '@vh_title')).toBe('auto title');
        expect(opt(NO_JSONL, '@vh_title_manual')).toBe('');
        expect(tmux('capture-pane', '-p', '-S', '-', '-t', `=vh-${NO_JSONL}:`).stdout).not.toContain('claude --resume');
    });

    it('refuses bad ids, unknown records and a missing directory without touching tmux', () => {
        expect(mgr.restoreClosedTerminal('=vh-x:')).toEqual({ type: 'error', reason: 'invalid-id' });
        expect(mgr.restoreClosedTerminal(42)).toEqual({ type: 'error', reason: 'invalid-id' });
        expect(mgr.restoreClosedTerminal('neverseen1')).toEqual({ type: 'error', reason: 'no-record' });
        expect(mgr.restoreClosedTerminal(GONEDIR)).toEqual({ type: 'error', reason: 'missing-cwd' });
        expect(sessionExists(GONEDIR)).toBe(false);
    });
});
