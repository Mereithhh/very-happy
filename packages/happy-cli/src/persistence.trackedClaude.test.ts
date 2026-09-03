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

    it('collects own and imported-from ids regardless of the live-session age prune', async () => {
        const ancient = Date.now() - 400 * 24 * 60 * 60 * 1000;
        await writeSessions({
            live: { savedAt: Date.now(), metadata: { claudeSessionId: A.toUpperCase() } },
            // readPersistedSessions() drops this one as too old; exclusion must not.
            old: { savedAt: ancient, metadata: { importedFromClaudeSessionId: B } },
            noConversation: { savedAt: Date.now(), metadata: {} },
        });
        const { readTrackedClaudeSessionIds, readPersistedSessions } = await import('./persistence');
        expect(readTrackedClaudeSessionIds().sort()).toEqual([A, B].sort());
        expect(Object.keys(readPersistedSessions())).not.toContain('old');
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
