import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isOverlayLocal, syncCodexOverlay } from './codexHome';

function base() {
    const root = mkdtempSync(join(tmpdir(), 'vh-b850b-overlay-'));
    const home = join(root, 'codex');
    mkdirSync(join(home, 'skills'), { recursive: true });
    writeFileSync(join(home, 'config.toml'), 'model = "m"\n');
    writeFileSync(join(home, 'auth.json'), '{"machine":"login"}');
    writeFileSync(join(home, 'AGENTS.md'), '# me');
    writeFileSync(join(home, 'state_5.sqlite'), '');
    writeFileSync(join(home, 'state_5.sqlite-wal'), '');
    mkdirSync(join(home, 'log'));
    return { root, home, overlay: join(root, 'acct', 'codex-home') };
}

describe('B-850b CODEX_HOME overlay', () => {
    it('links the user\'s config / sessions / skills, never auth.json, sqlite state or logs', () => {
        const { home, overlay } = base();
        const changed = syncCodexOverlay(overlay, home, 1);
        expect(changed.sort()).toEqual(['AGENTS.md', 'archived_sessions', 'config.toml', 'sessions', 'skills']);
        expect(readlinkSync(join(overlay, 'sessions'))).toBe(join(home, 'sessions'));
        expect(existsSync(join(home, 'sessions'))).toBe(true);
        for (const local of ['auth.json', 'state_5.sqlite', 'state_5.sqlite-wal', 'log']) expect(existsSync(join(overlay, local))).toBe(false);
        expect(syncCodexOverlay(overlay, home, 2)).toEqual([]);
    });

    it('a linked file Codex replaced with a real one is kept aside, then relinked; the account\'s auth.json stays', () => {
        const { home, overlay } = base();
        syncCodexOverlay(overlay, home, 1);
        rmSync(join(overlay, 'config.toml'));
        writeFileSync(join(overlay, 'config.toml'), 'edited in overlay');
        writeFileSync(join(overlay, 'auth.json'), '{"account":"b"}');
        expect(syncCodexOverlay(overlay, home, 7)).toEqual(['config.toml']);
        expect(lstatSync(join(overlay, 'config.toml')).isSymbolicLink()).toBe(true);
        expect(readFileSync(join(overlay, 'config.toml.overlay-7'), 'utf8')).toBe('edited in overlay');
        expect(readFileSync(join(overlay, 'auth.json'), 'utf8')).toBe('{"account":"b"}');
        expect(readFileSync(join(home, 'auth.json'), 'utf8')).toBe('{"machine":"login"}');
    });

    it('removing an account deletes the links, never the shared history behind them', () => {
        const { root, home, overlay } = base();
        syncCodexOverlay(overlay, home, 1);
        writeFileSync(join(home, 'sessions', 'rollout.jsonl'), 'history');
        rmSync(join(root, 'acct'), { recursive: true, force: true });
        expect(readFileSync(join(home, 'sessions', 'rollout.jsonl'), 'utf8')).toBe('history');
        expect(readFileSync(join(home, 'config.toml'), 'utf8')).toBe('model = "m"\n');
    });

    it('local-entry rules', () => {
        for (const n of ['auth.json', 'logs_2.sqlite', 'goals_1.sqlite-shm', 'models_cache.json', 'tmp', 'cache']) expect(isOverlayLocal(n)).toBe(true);
        for (const n of ['config.toml', 'sessions', 'skills', 'AGENTS.md', 'thread-writer-locks', 'shell_snapshots']) expect(isOverlayLocal(n)).toBe(false);
    });
});
