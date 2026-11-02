import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import {
    forkBeforeUserMessage,
    listClaudeRewindPoints,
    discardForkedSession,
    forkSession,
    forkCompletedTurns,
    findUnfinishedTurn,
    completeLines,
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

    it('rewinds before the exact user UUID and leaves original bytes untouched', async () => {
        const entries = [
            { type: 'user', uuid: 'u1', message: { content: 'same text' } },
            { type: 'assistant', uuid: 'a1', message: { content: 'answer' } },
            { type: 'user', uuid: 'u2', message: { content: 'same text' } },
            { type: 'assistant', uuid: 'a2', message: { content: 'later' } },
        ];
        const source = await writeSource(entries);
        const original = await readFile(source, 'utf-8');
        const fork = await forkBeforeUserMessage(projectDir, sourceId, 'u2');
        expect(await readJsonl(fork!)).toEqual(entries.slice(0, 2));
        expect(await readFile(source, 'utf-8')).toBe(original);
        expect(await forkBeforeUserMessage(projectDir, sourceId, 'u1')).toBeNull();
        await expect(forkBeforeUserMessage(projectDir, sourceId, 'missing')).rejects.toBeInstanceOf(ForkTruncateUuidNotFoundError);
        await expect(forkBeforeUserMessage(projectDir, sourceId, 'a1')).rejects.toBeInstanceOf(ForkTruncateUuidNotFoundError);
    });

    it('lists and rewinds array text prompts without treating later strings as first messages', async () => {
        const entries = [
            { type: 'user', uuid: 'array-1', message: { content: [{ type: 'text', text: 'say lol' }] } },
            { type: 'assistant', uuid: 'answer-1', message: { content: 'lol' } },
            { type: 'user', uuid: 'tool', message: { content: [{ type: 'tool_result', content: 'done' }, { type: 'text', text: 'tool context' }] } },
            { type: 'user', uuid: 'side', isSidechain: true, message: { content: [{ type: 'text', text: 'side prompt' }] } },
            { type: 'user', uuid: 'meta', isMeta: true, message: { content: [{ type: 'text', text: 'injected' }] } },
            { type: 'user', uuid: 'array-2', message: { content: [{ type: 'text', text: 'second' }, { type: 'text', text: 'part' }] } },
            { type: 'user', uuid: 'string-3', message: { content: 'third' } },
        ];
        const source = await writeSource(entries);
        const original = await readFile(source, 'utf-8');
        expect((await listClaudeRewindPoints(projectDir, sourceId)).map(({ uuid, text }) => ({ uuid, text })))
            .toEqual([{ uuid: 'array-1', text: 'say lol' }, { uuid: 'array-2', text: 'second\npart' }, { uuid: 'string-3', text: 'third' }]);
        expect(await forkBeforeUserMessage(projectDir, sourceId, 'array-1')).toBeNull();
        const arrayFork = await forkBeforeUserMessage(projectDir, sourceId, 'array-2');
        expect(await readJsonl(arrayFork!)).toEqual(entries.slice(0, 5));
        const stringFork = await forkBeforeUserMessage(projectDir, sourceId, 'string-3');
        expect(stringFork).not.toBeNull();
        expect(await readJsonl(stringFork!)).toEqual(entries.slice(0, 6));
        for (const id of ['tool', 'side', 'meta']) {
            await expect(forkBeforeUserMessage(projectDir, sourceId, id)).rejects.toBeInstanceOf(ForkTruncateUuidNotFoundError);
        }
        expect(await readFile(source, 'utf-8')).toBe(original);
    });

    it('preserves earlier image-only history before the first editable text prompt', async () => {
        const entries = [
            { type: 'user', uuid: 'image', message: { content: [{ type: 'image', source: { type: 'base64', data: 'test' } }] } },
            { type: 'user', uuid: 'text', message: { content: 'describe it differently' } },
        ];
        await writeSource(entries);
        const fork = await forkBeforeUserMessage(projectDir, sourceId, 'text');
        expect(fork).not.toBeNull();
        expect(await readJsonl(fork!)).toEqual(entries.slice(0, 1));
    });

    it('marks attachments in rewind points and rejects tool-only prior history', async () => {
        await writeSource([
            { type: 'user', uuid: 'tool', message: { content: [{ type: 'tool_result', content: 'orphan' }] } },
            { type: 'user', uuid: 'target', message: { content: [{ type: 'text', text: 'describe' }, { type: 'image', source: {} }] } },
        ]);
        expect(await listClaudeRewindPoints(projectDir, sourceId)).toEqual([
            expect.objectContaining({ uuid: 'target', text: 'describe', hasAttachments: true }),
        ]);
        await expect(forkBeforeUserMessage(projectDir, sourceId, 'target')).rejects.toThrow('with attachments');
        await writeSource([{ type: 'user', uuid: 'manifest', message: { content: 'look\n<attached_files>file</attached_files>' } }]);
        expect(await listClaudeRewindPoints(projectDir, sourceId)).toEqual([expect.objectContaining({ uuid: 'manifest', hasAttachments: true })]);
        await expect(forkBeforeUserMessage(projectDir, sourceId, 'manifest')).rejects.toThrow('with attachments');
        await writeSource([
            { type: 'user', uuid: 'orphan', message: { content: [{ type: 'tool_result', content: 'result' }] } },
            { type: 'user', uuid: 'plain', message: { content: 'plain' } },
        ]);
        await expect(forkBeforeUserMessage(projectDir, sourceId, 'plain')).rejects.toThrow('earlier history has no user prompt');
    });

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
        it('keeps chosen turn complete (user + agent response) and drops the next prompt onwards', async () => {
            await writeSource([
                { type: 'user', uuid: 'u1', message: { role: 'user', content: 'first' } },
                { type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: 'reply' } },
                { type: 'user', uuid: 'u2', message: { role: 'user', content: 'cut here' } },
                { type: 'assistant', uuid: 'a2', message: { role: 'assistant', content: 'response to cut' } },
                { type: 'user', uuid: 'u3', message: { role: 'user', content: 'next prompt' } },
                { type: 'assistant', uuid: 'a3', message: { role: 'assistant', content: 'should not appear' } },
            ]);

            const newId = await forkAndTruncateSession(projectDir, sourceId, 'u2');
            const out = await readJsonl(newId);

            expect(out).toHaveLength(4);
            expect(out[0]).toMatchObject({ uuid: 'u1' });
            expect(out[1]).toMatchObject({ uuid: 'a1' });
            expect(out[2]).toMatchObject({ uuid: 'u2' });
            expect(out[3]).toMatchObject({ uuid: 'a2' });
        });

        it('keeps trailing tool_use/tool_result chain belonging to the chosen turn', async () => {
            await writeSource([
                { type: 'user', uuid: 'u1', message: { role: 'user', content: 'list files' } },
                { type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1' }] } },
                // Tool result is still type=user but with array content, isSidechain=false → not a "next prompt"
                { type: 'user', uuid: 'tr1', isSidechain: false, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1' }] } },
                { type: 'assistant', uuid: 'a1b', message: { role: 'assistant', content: 'final answer' } },
                { type: 'user', uuid: 'u2', message: { role: 'user', content: 'next prompt' } },
            ]);

            const newId = await forkAndTruncateSession(projectDir, sourceId, 'u1');
            const out = await readJsonl(newId);

            expect(out.map((e: any) => e.uuid)).toEqual(['u1', 'a1', 'tr1', 'a1b']);
        });

        it('cut at the last user prompt copies the entire file (no prompt after to gate on)', async () => {
            await writeSource([
                { type: 'user', uuid: 'u1', message: { role: 'user', content: 'first' } },
                { type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: 'reply' } },
                { type: 'user', uuid: 'u2', message: { role: 'user', content: 'last prompt' } },
                { type: 'assistant', uuid: 'a2', message: { role: 'assistant', content: 'last reply' } },
            ]);

            const newId = await forkAndTruncateSession(projectDir, sourceId, 'u2');
            const out = await readJsonl(newId);

            expect(out.map((e: any) => e.uuid)).toEqual(['u1', 'a1', 'u2', 'a2']);
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
                { type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: 'reply' } },
                { type: 'user', uuid: 'u2', message: { role: 'user', content: 'cut here' } },
            ]);

            const newId = await forkAndTruncateSession(projectDir, sourceId, 'u1');
            const out = await readJsonl(newId);

            expect(out).toHaveLength(3);
            expect(out[0]).toMatchObject({ type: 'summary', leafUuid: 'u0' });
            expect(out[1]).toMatchObject({ uuid: 'u1' });
            expect(out[2]).toMatchObject({ uuid: 'a1' });
        });

        it('skips malformed JSON lines but still finds the cut uuid', async () => {
            const path = join(projectDir, `${sourceId}.jsonl`);
            const body = [
                JSON.stringify({ type: 'user', uuid: 'u1', message: { role: 'user', content: 'cut here' } }),
                '{this is not valid JSON',
                JSON.stringify({ type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: 'reply' } }),
                JSON.stringify({ type: 'user', uuid: 'u2', message: { role: 'user', content: 'next prompt' } }),
            ].join('\n') + '\n';
            await writeFile(path, body, 'utf-8');

            const newId = await forkAndTruncateSession(projectDir, sourceId, 'u1');
            const raw = await readFile(join(projectDir, `${newId}.jsonl`), 'utf-8');
            const lines = raw.split('\n').filter((l) => l.length > 0);

            // u1 (marker), the malformed line, and a1 (agent response)
            // all land in the fork. u2 is the next user prompt — that's
            // the cut point, dropped along with anything that follows.
            expect(lines).toHaveLength(3);
            expect(JSON.parse(lines[0])).toMatchObject({ uuid: 'u1' });
            expect(lines[1]).toBe('{this is not valid JSON');
            expect(JSON.parse(lines[2])).toMatchObject({ uuid: 'a1' });
        });

        it('throws ForkSourceMissingError when source jsonl is absent', async () => {
            await expect(forkAndTruncateSession(projectDir, 'does-not-exist', 'u1'))
                .rejects.toBeInstanceOf(ForkSourceMissingError);
        });
    });

    describe('discardForkedSession', () => {
        it('removes a fork that was created for a session that never started', async () => {
            await writeSource([
                { type: 'user', uuid: 'u1', message: { role: 'user', content: 'hi' } },
            ]);
            const newId = await forkSession(projectDir, sourceId);
            expect(existsSync(join(projectDir, `${newId}.jsonl`))).toBe(true);

            await discardForkedSession(projectDir, newId);
            expect(existsSync(join(projectDir, `${newId}.jsonl`))).toBe(false);
            // the source is never touched
            expect(existsSync(join(projectDir, `${sourceId}.jsonl`))).toBe(true);
        });

        it('is a no-op when the file is already gone', async () => {
            await expect(discardForkedSession(projectDir, '11111111-1111-1111-1111-111111111111')).resolves.toBeUndefined();
        });
    });
    describe('B-860: forking a running session', () => {
        const user = (uuid: string, content: unknown, extra: object = {}) => ({ type: 'user', uuid, message: { role: 'user', content }, ...extra });
        const assistant = (uuid: string, stop: string | null, text = 'x') => ({ type: 'assistant', uuid, message: { role: 'assistant', content: [{ type: 'text', text }], stop_reason: stop } });
        const toolResult = (uuid: string) => user(uuid, [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }]);
        const done = [user('u1', 'remember ALPHA'), assistant('a1', 'end_turn', 'OK')];

        async function writeRaw(raw: string): Promise<string> {
            const path = join(projectDir, `${sourceId}.jsonl`);
            await writeFile(path, raw, 'utf-8');
            return path;
        }
        const jsonl = (entries: object[]) => entries.map((e) => JSON.stringify(e)).join('\n') + '\n';

        it('drops a torn last line but keeps a complete one still missing its newline', () => {
            const a = JSON.stringify(user('u1', 'hi'));
            const b = JSON.stringify(assistant('a1', 'end_turn'));
            expect(completeLines(`${a}\n${b}\n`)).toEqual([a, b]);
            expect(completeLines(`${a}\n${b}`)).toEqual([a, b]);
            expect(completeLines(`${a}\n${b.slice(0, 20)}`)).toEqual([a]);
            expect(completeLines('')).toEqual([]);
        });

        it('cuts the turn in progress — tool calls, a torn last line and a steered prompt included', async () => {
            const running = [
                user('u2', 'run the long task'),
                assistant('a2', 'tool_use'),
                toolResult('r2'),
                user('u3', 'also check the logs'),
                assistant('a3', 'tool_use'),
            ];
            const source = await writeRaw(jsonl([...done, ...running]) + JSON.stringify(assistant('a4', null)).slice(0, 30));
            const original = await readFile(source, 'utf-8');
            const result = await forkCompletedTurns(projectDir, sourceId);
            expect(result).toEqual({ newClaudeSessionId: expect.any(String), excludedPrompts: ['run the long task', 'also check the logs'] });
            expect(await readJsonl((result as { newClaudeSessionId: string }).newClaudeSessionId)).toEqual(done);
            expect(await readFile(source, 'utf-8')).toBe(original);
        });

        it('copies everything when the transcript already ends on a closed turn', async () => {
            await writeRaw(jsonl([...done, { type: 'last-prompt', lastPrompt: 'x' }]));
            const result = await forkCompletedTurns(projectDir, sourceId);
            expect(result).toMatchObject({ excludedPrompts: [] });
            expect(await readJsonl((result as { newClaudeSessionId: string }).newClaudeSessionId)).toEqual([...done, { type: 'last-prompt', lastPrompt: 'x' }]);
        });

        it('first turn still running: nothing completed → startFresh with the prompt handed back', async () => {
            await writeRaw(jsonl([user('u1', 'first'), assistant('a1', 'tool_use')]));
            expect(await forkCompletedTurns(projectDir, sourceId)).toEqual({ startFresh: true, excludedPrompts: ['first'] });
        });

        it('an interrupt, a local command and a compaction each close the turn before', () => {
            const lines = (entries: object[]) => entries.map((e) => JSON.stringify(e));
            const tail = [user('u9', 'next'), assistant('a9', 'tool_use')];
            for (const closer of [
                user('i1', '[Request interrupted by user for tool use]'),
                user('c1', '<local-command-stdout>Set model to opus</local-command-stdout>'),
                { type: 'system', subtype: 'compact_boundary', uuid: 'b1' },
                user('s1', 'This session is being continued from a previous conversation…', { isCompactSummary: true }),
                assistant('e1', 'stop_sequence'),
            ]) {
                const all = lines([user('u1', 'a'), assistant('a1', 'tool_use'), closer, ...tail]);
                expect(findUnfinishedTurn(all)).toEqual({ start: 3, prompts: ['next'] });
            }
            // tool_use / pause_turn stops do not close a turn; sidechain answers never do.
            const open = lines([...done, user('u2', 'go'), assistant('a2', 'pause_turn'), { ...assistant('s2', 'end_turn'), isSidechain: true }]);
            expect(findUnfinishedTurn(open)).toEqual({ start: 2, prompts: ['go'] });
            expect(findUnfinishedTurn(lines(done))).toBeNull();
        });

        it('rewind-before and the whole copy ignore a torn last line', async () => {
            await writeRaw(jsonl([...done, user('u2', 'second'), assistant('a2', 'tool_use')]) + '{"type":"assist');
            const before = await forkBeforeUserMessage(projectDir, sourceId, 'u2');
            expect(await readJsonl(before!)).toEqual(done);
            const whole = await forkSession(projectDir, sourceId);
            expect(await readJsonl(whole)).toEqual([...done, user('u2', 'second'), assistant('a2', 'tool_use')]);
        });
    });
});
