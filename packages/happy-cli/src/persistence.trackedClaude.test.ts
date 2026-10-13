import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const originalEnv = { ...process.env };
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

describe('readTrackedClaudeSessionIds (B-291)', () => {
    let home: string;

    beforeEach(async () => {
        home = join(tmpdir(), `vh-tracked-ids-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        await mkdir(home, { recursive: true });
        process.env = { ...originalEnv, HAPPY_HOME_DIR: home };
        vi.resetModules();
    });

    afterEach(async () => {
        process.env = { ...originalEnv };
        await rm(home, { recursive: true, force: true });
    });

    async function writeSessions(sessions: object) {
        await writeFile(join(home, 'sessions.json'), JSON.stringify({ sessions }));
    }

    it('B-587: a hibernated record is kept 90 days, an ordinary one 14', async () => {
        const day = 24 * 60 * 60 * 1000;
        const twentyDaysAgo = Date.now() - 20 * day;
        await writeSessions({
            hibernated: { savedAt: twentyDaysAgo, hibernatedAt: twentyDaysAgo, metadata: {} },
            offline: { savedAt: twentyDaysAgo, metadata: {} },
            // resumed after hibernating: savedAt moved on, the old stamp no longer counts
            resumedLongAgo: { savedAt: twentyDaysAgo, hibernatedAt: twentyDaysAgo - day, metadata: {} },
            tooOld: { savedAt: Date.now() - 91 * day, hibernatedAt: Date.now() - 91 * day, metadata: {} },
        });
        const { readPersistedSessions } = await import('./persistence');
        expect(Object.keys(readPersistedSessions()).sort()).toEqual(['hibernated']);
    });

    it('B-587: record rewrites keep the keep-awake latch unless they set it', async () => {
        await writeSessions({ s: { savedAt: Date.now(), keepAwake: true, metadata: {} } });
        const { persistSession, readPersistedSessions } = await import('./persistence');
        persistSession('s', { savedAt: Date.now(), metadata: {} } as never);
        expect(readPersistedSessions().s.keepAwake).toBe(true);
        persistSession('s', { savedAt: Date.now(), metadata: {}, keepAwake: undefined } as never);
        expect(readPersistedSessions().s.keepAwake).toBeUndefined();
    });

    it('collects own conversation ids regardless of the live-session age prune', async () => {
        const ancient = Date.now() - 400 * 24 * 60 * 60 * 1000;
        await writeSessions({
            live: { savedAt: Date.now(), metadata: { claudeSessionId: A.toUpperCase() } },
            // readPersistedSessions() drops this one as too old; exclusion must not.
            old: { savedAt: ancient, metadata: { claudeSessionId: B } },
            noConversation: { savedAt: Date.now(), metadata: {} },
        });
        const { readTrackedClaudeSessionIds, readPersistedSessions } = await import('./persistence');
        expect(readTrackedClaudeSessionIds().sort()).toEqual([A, B].sort());
        expect(Object.keys(readPersistedSessions())).not.toContain('old');
    });

    it('B-600: the original an import came from is not tracked (a failed import must not hide it)', async () => {
        const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
        const D = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
        await writeSessions({
            // The birth snapshot a Codex import leaves (fork id never reaches
            // sessions.json, B-537 PR notes) — identical for a failed fork.
            codexShell: { savedAt: Date.now(), metadata: { importedFromCodexThreadId: A } },
            codexOwn: { savedAt: Date.now(), metadata: { codexThreadId: C } },
            claudeImport: { savedAt: Date.now(), metadata: { claudeSessionId: D, importedFromClaudeSessionId: B } },
        });
        const { readTrackedClaudeSessionIds, readTrackedCodexThreadIds } = await import('./persistence');
        expect(readTrackedCodexThreadIds()).toEqual([C]);
        expect(readTrackedClaudeSessionIds()).toEqual([D]);
    });

    it('is empty and never throws when the store is missing or malformed', async () => {
        const { readTrackedClaudeSessionIds } = await import('./persistence');
        expect(readTrackedClaudeSessionIds()).toEqual([]);
        await writeFile(join(home, 'sessions.json'), 'not json');
        vi.resetModules();
        const again = await import('./persistence');
        expect(again.readTrackedClaudeSessionIds()).toEqual([]);
    });
});
