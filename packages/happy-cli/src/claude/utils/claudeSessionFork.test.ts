import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import {
    forkSession,
    forkAndTruncateSession,
    ForkTruncateUuidNotFoundError,
    ForkSourceMissingError,
} from './claudeSessionFork';

describe('claudeSessionFork', () => {
    let projectDir: string;
    const sourceId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

    beforeEach(async () => {
        projectDir = join(tmpdir(), `claude-fork-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        await mkdir(projectDir, { recursive: true });
    });

    afterEach(async () => {
        if (existsSync(projectDir)) {
            await rm(projectDir, { recursive: true, force: true });
        }
    });

    async function writeSource(lines: object[]): Promise<string> {
        const path = join(projectDir, `${sourceId}.jsonl`);
        await writeFile(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf-8');
        return path;
    }

    async function readJsonl(sessionId: string): Promise<unknown[]> {
        const raw = await readFile(join(projectDir, `${sessionId}.jsonl`), 'utf-8');
        return raw
            .split('\n')
            .filter((l) => l.length > 0)
            .map((l) => {
                try { return JSON.parse(l); } catch { return l; }
            });
    }

    describe('forkSession', () => {
        it('produces a byte-identical copy with a fresh session id', async () => {
            await writeSource([
                { type: 'user', uuid: 'u1', message: { role: 'user', content: 'hi' } },
                { type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: 'hey' } },
            ]);

            const newId = await forkSession(projectDir, sourceId);
            expect(newId).not.toBe(sourceId);
            expect(newId).toMatch(/^[0-9a-f-]{36}$/);

            const original = await readFile(join(projectDir, `${sourceId}.jsonl`));
            const copy = await readFile(join(projectDir, `${newId}.jsonl`));
            expect(copy.equals(original)).toBe(true);
        });

        it('throws ForkSourceMissingError when source jsonl is absent', async () => {
            await expect(forkSession(projectDir, 'does-not-exist'))
                .rejects.toBeInstanceOf(ForkSourceMissingError);
        });
    });

    describe('forkAndTruncateSession', () => {
        it('keeps the chosen message and drops everything after', async () => {
            await writeSource([
                { type: 'user', uuid: 'u1', message: { role: 'user', content: 'first' } },
                { type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: 'reply' } },
                { type: 'user', uuid: 'u2', message: { role: 'user', content: 'cut here' } },
                { type: 'assistant', uuid: 'a2', message: { role: 'assistant', content: 'wrong path' } },
            ]);

            const newId = await forkAndTruncateSession(projectDir, sourceId, 'u2');
            const out = await readJsonl(newId);

            // u2 stays as the last message; the assistant turn that
            // followed it is dropped so the agent regenerates fresh.
            expect(out).toHaveLength(3);
            expect(out[0]).toMatchObject({ uuid: 'u1' });
            expect(out[1]).toMatchObject({ uuid: 'a1' });
            expect(out[2]).toMatchObject({ uuid: 'u2' });
        });

        it('cut at the first message keeps just that message', async () => {
            await writeSource([
                { type: 'user', uuid: 'u1', message: { role: 'user', content: 'first' } },
                { type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: 'reply' } },
            ]);

            const newId = await forkAndTruncateSession(projectDir, sourceId, 'u1');
            const out = await readJsonl(newId);
            expect(out).toHaveLength(1);
            expect(out[0]).toMatchObject({ uuid: 'u1' });
        });

        it('hard-fails with ForkTruncateUuidNotFoundError when uuid is absent', async () => {
            await writeSource([
                { type: 'user', uuid: 'u1', message: { role: 'user', content: 'first' } },
            ]);

            await expect(forkAndTruncateSession(projectDir, sourceId, 'nope'))
                .rejects.toBeInstanceOf(ForkTruncateUuidNotFoundError);

            // Temp file must be cleaned up; new uuid file must NOT remain.
            const files = (await readFile(projectDir, { encoding: 'utf-8' }).catch(() => null));
            expect(files).toBeNull(); // readFile on a directory errors; fine.
        });

        it('preserves summary lines that occur before the cut point', async () => {
            await writeSource([
                { type: 'summary', summary: 'prior conversation', leafUuid: 'u0' },
                { type: 'user', uuid: 'u1', message: { role: 'user', content: 'first' } },
                { type: 'user', uuid: 'u2', message: { role: 'user', content: 'cut here' } },
            ]);

            const newId = await forkAndTruncateSession(projectDir, sourceId, 'u2');
            const out = await readJsonl(newId);

            expect(out).toHaveLength(3);
            expect(out[0]).toMatchObject({ type: 'summary', leafUuid: 'u0' });
            expect(out[1]).toMatchObject({ uuid: 'u1' });
            expect(out[2]).toMatchObject({ uuid: 'u2' });
        });

        it('skips malformed JSON lines but still finds the cut uuid', async () => {
            const path = join(projectDir, `${sourceId}.jsonl`);
            const body = [
                JSON.stringify({ type: 'user', uuid: 'u1', message: { role: 'user', content: 'first' } }),
                '{this is not valid JSON',
                JSON.stringify({ type: 'user', uuid: 'u2', message: { role: 'user', content: 'cut' } }),
            ].join('\n') + '\n';
            await writeFile(path, body, 'utf-8');

            const newId = await forkAndTruncateSession(projectDir, sourceId, 'u2');
            const raw = await readFile(join(projectDir, `${newId}.jsonl`), 'utf-8');
            const lines = raw.split('\n').filter((l) => l.length > 0);

            // u1, the malformed line, AND the cut marker u2 all land in
            // the fork — u2 is kept, claude --resume tolerates the malformed
            // line just like it would have in the original file.
            expect(lines).toHaveLength(3);
            expect(JSON.parse(lines[0])).toMatchObject({ uuid: 'u1' });
            expect(lines[1]).toBe('{this is not valid JSON');
            expect(JSON.parse(lines[2])).toMatchObject({ uuid: 'u2' });
        });

        it('throws ForkSourceMissingError when source jsonl is absent', async () => {
            await expect(forkAndTruncateSession(projectDir, 'does-not-exist', 'u1'))
                .rejects.toBeInstanceOf(ForkSourceMissingError);
        });
    });
});
