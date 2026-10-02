import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConversationRewindError, rewindClaudeTranscript, rewindTranscriptLines } from './claudeTranscriptRewind';

const u = (uuid: string, content: unknown, parentUuid: string | null, extra: object = {}) => ({ type: 'user', uuid, parentUuid, message: { role: 'user', content }, ...extra });
const a = (uuid: string, parentUuid: string, text = 'answer') => ({ type: 'assistant', uuid, parentUuid, message: { role: 'assistant', content: [{ type: 'text', text }] } });
const toolResult = (uuid: string, parentUuid: string) => u(uuid, [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }], parentUuid);

const conversation = [
    { type: 'queue-operation', operation: 'enqueue' },
    u('p1', 'first', null),
    a('a1', 'p1'),
    u('p2', 'second', 'a1'),
    a('a2', 'p2'),
    toolResult('r2', 'a2'),
    a('a2b', 'r2'),
    u('p3', [{ type: 'text', text: 'third' }], 'a2b'),
    a('a3', 'p3'),
];
const lines = conversation.map((entry) => JSON.stringify(entry));
const parse = (kept: string[] | null) => kept?.map((line) => JSON.parse(line));

describe('rewindTranscriptLines', () => {
    it('edit keeps only the history before the exact prompt uuid', () => {
        const kept = parse(rewindTranscriptLines(lines, 'edit', { uuids: ['p2'] }));
        expect(kept?.map((entry) => entry.uuid)).toEqual([undefined, 'p1', 'a1']);
    });

    it('delete drops the whole turn and re-parents the next prompt onto the target parent', () => {
        const kept = parse(rewindTranscriptLines(lines, 'delete', { uuids: ['p2'] }));
        expect(kept?.map((entry) => entry.uuid)).toEqual([undefined, 'p1', 'a1', 'p3', 'a3']);
        expect(kept?.find((entry) => entry.uuid === 'p3')?.parentUuid).toBe('a1');
        // Untouched lines keep their original bytes.
        expect(rewindTranscriptLines(lines, 'delete', { uuids: ['p2'] })?.at(-1)).toBe(lines.at(-1));
    });

    it('deleting the first turn makes the next prompt the root', () => {
        const kept = parse(rewindTranscriptLines(lines, 'delete', { uuids: ['p1'] }));
        expect(kept?.find((entry) => entry.uuid === 'p2')?.parentUuid).toBeNull();
        expect(kept?.some((entry) => entry.uuid === 'a1')).toBe(false);
    });

    it('returns null when nothing of the conversation would remain', () => {
        expect(rewindTranscriptLines(lines, 'edit', { uuids: ['p1'] })).toBeNull();
        const single = lines.slice(0, 3);
        expect(rewindTranscriptLines(single, 'delete', { uuids: ['p1'] })).toBeNull();
    });

    it('deleting the last turn equals editing it', () => {
        expect(rewindTranscriptLines(lines, 'delete', { uuids: ['p3'] })).toEqual(rewindTranscriptLines(lines, 'edit', { uuids: ['p3'] }));
    });

    it('tries uuids in order, then a unique exact text match', () => {
        expect(parse(rewindTranscriptLines(lines, 'edit', { uuids: ['missing', 'p3'] }))?.at(-1).uuid).toBe('a2b');
        expect(parse(rewindTranscriptLines(lines, 'edit', { uuids: ['web-local-id'], text: ' third ' }))?.at(-1).uuid).toBe('a2b');
    });

    it('never guesses between duplicate texts, and never targets a tool result', () => {
        const dup = [...lines, JSON.stringify(u('p4', 'second', 'a3'))];
        expect(() => rewindTranscriptLines(dup, 'edit', { uuids: [], text: 'second' })).toThrow(ConversationRewindError);
        expect(() => rewindTranscriptLines(lines, 'edit', { uuids: ['r2'] })).toThrow(/not in the agent conversation/);
    });
});

describe('rewindClaudeTranscript', () => {
    let dir: string;
    beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'vh-rewind-')); });
    afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

    it('writes a new session file and leaves the source bytes untouched', async () => {
        const source = join(dir, 'src.jsonl');
        await writeFile(source, lines.join('\n') + '\n');
        const id = await rewindClaudeTranscript(dir, 'src', 'delete', { uuids: ['p2'] });
        expect(id).toMatch(/^[0-9a-f-]{36}$/);
        const written = (await readFile(join(dir, `${id}.jsonl`), 'utf-8')).trim().split('\n').map((line) => JSON.parse(line));
        expect(written.map((entry) => entry.uuid)).toEqual([undefined, 'p1', 'a1', 'p3', 'a3']);
        expect(await readFile(source, 'utf-8')).toBe(lines.join('\n') + '\n');
        expect(await rewindClaudeTranscript(dir, 'src', 'edit', { uuids: ['p1'] })).toBeNull();
    });
});
