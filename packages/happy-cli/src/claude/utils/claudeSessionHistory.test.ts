import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, rm, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import { BOARD_ANALYZER_PROMPT_PREFIX, TITLE_PROMPT_PREFIX } from './oneShotPrompts';
import {
    listClaudeProjectDirs,
    listClaudeSessionHistory,
    parseClaudeHistoryHead,
} from './claudeSessionHistory';

const idA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const idB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const idC = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const idD = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

function userLine(text: string, extra: Record<string, unknown> = {}) {
    return { type: 'user', uuid: 'u', cwd: '/work/app', entrypoint: 'cli', gitBranch: 'main', version: '2.1.258', timestamp: '2026-09-01T10:00:00.000Z', message: { role: 'user', content: text }, ...extra };
}

describe('claudeSessionHistory', () => {
    let root: string;
    let projA: string;
    let projB: string;

    beforeEach(async () => {
        root = join(tmpdir(), `claude-history-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        projA = join(root, 'projects', '-work-app');
        projB = join(root, 'projects', '-work-other');
        await mkdir(projA, { recursive: true });
        await mkdir(projB, { recursive: true });
        await writeFile(join(root, 'projects', 'stray.txt'), 'x');
    });

    afterEach(async () => {
        if (existsSync(root)) await rm(root, { recursive: true, force: true });
    });

    async function writeJsonl(dir: string, id: string, lines: object[], mtimeSec?: number) {
        const path = join(dir, `${id}.jsonl`);
        await writeFile(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf-8');
        if (mtimeSec !== undefined) await utimes(path, mtimeSec, mtimeSec);
        return path;
    }

    it('lists only project directories under the projects root', async () => {
        const dirs = await listClaudeProjectDirs(join(root, 'projects'));
        expect(dirs.sort()).toEqual([projA, projB].sort());
        expect(await listClaudeProjectDirs(join(root, 'missing'))).toEqual([]);
    });

    it('returns newest-first entries with cwd, first prompt and metadata', async () => {
        await writeJsonl(projA, idA, [
            { type: 'file-history-snapshot', messageId: 'x' },
            userLine('Fix the login bug\nplease'),
            { type: 'assistant', uuid: 'a', message: { role: 'assistant', content: 'ok' } },
        ], 1000);
        await writeJsonl(projB, idB, [
            userLine('Write docs', { cwd: '/work/other', entrypoint: 'sdk-cli' }),
        ], 2000);

        const result = await listClaudeSessionHistory({ projectDirs: [projA, projB] });
        expect(result.truncated).toBe(false);
        expect(result.entries.map((e) => e.claudeSessionId)).toEqual([idB, idA]);
        const a = result.entries[1];
        expect(a).toMatchObject({
            cwd: '/work/app',
            firstPrompt: 'Fix the login bug please',
            entrypoint: 'cli',
            gitBranch: 'main',
            version: '2.1.258',
            startedAt: Date.parse('2026-09-01T10:00:00.000Z'),
        });
        expect(a.sizeBytes).toBeGreaterThan(0);
        expect(a.updatedAt).toBe(1000 * 1000);
        expect(result.entries[0].entrypoint).toBe('sdk-cli');
    });

    it('skips non-uuid names, empty files, excluded ids and transcripts without a prompt', async () => {
        await writeFile(join(projA, 'notes.jsonl'), JSON.stringify(userLine('hi')) + '\n');
        await writeFile(join(projA, `${idC}.jsonl`), '');
        await writeJsonl(projA, idA, [userLine('tracked already')]);
        await writeJsonl(projA, idB, [
            { type: 'user', cwd: '/work/app', message: { role: 'user', content: [{ type: 'tool_result', content: 'x' }] } },
        ]);
        await writeJsonl(projA, idD, [
            // no cwd anywhere → cannot be spawned, so it is not listed
            { type: 'user', message: { role: 'user', content: 'where am I' } },
        ]);

        const result = await listClaudeSessionHistory({ projectDirs: [projA], exclude: [idA.toUpperCase()] });
        expect(result.entries).toEqual([]);
    });

    it('lists one row per conversation id when the same id exists in two project dirs', async () => {
        await writeJsonl(projA, idA, [userLine('older copy')], 1000);
        await writeJsonl(projB, idA, [userLine('newer copy', { cwd: '/work/other' })], 3000);

        const result = await listClaudeSessionHistory({ projectDirs: [projA, projB] });
        expect(result.entries).toHaveLength(1);
        expect(result.entries[0]).toMatchObject({ claudeSessionId: idA, cwd: '/work/other', firstPrompt: 'newer copy' });
    });

    it("hides very-happy's own one-shot helper transcripts", async () => {
        await writeJsonl(projA, idA, [userLine(`${TITLE_PROMPT_PREFIX} (match the message's language). …\n\nMessage: "fix the tests"`)]);
        await writeJsonl(projB, idB, [userLine(`${BOARD_ANALYZER_PROMPT_PREFIX} Analyze this session snapshot …`, { cwd: '/work/other' })]);
        await writeJsonl(projA, idC, [userLine('a real conversation')]);

        const result = await listClaudeSessionHistory({ projectDirs: [projA, projB] });
        expect(result.entries.map((e) => e.firstPrompt)).toEqual(['a real conversation']);
    });

    it('honours limit and reports truncation without reading every file', async () => {
        for (let i = 0; i < 5; i++) {
            const id = `${i}${i}${i}${i}${i}${i}${i}${i}-0000-4000-8000-000000000000`;
            await writeJsonl(projA, id, [userLine(`prompt ${i}`)], 1000 + i);
        }
        const result = await listClaudeSessionHistory({ projectDirs: [projA], limit: 2 });
        expect(result.entries).toHaveLength(2);
        expect(result.entries.map((e) => e.firstPrompt)).toEqual(['prompt 4', 'prompt 3']);
        expect(result.truncated).toBe(true);
        expect(result.scanned).toBe(2);
    });

    it('prefers a summary line as title and reads text blocks from block content', async () => {
        await writeJsonl(projA, idA, [
            { type: 'summary', summary: 'Login bug investigation', leafUuid: 'z' },
            { type: 'user', cwd: '/work/app', message: { role: 'user', content: [{ type: 'text', text: '<system-reminder>ignored</system-reminder>look at auth.ts' }] } },
        ]);
        const [entry] = (await listClaudeSessionHistory({ projectDirs: [projA] })).entries;
        expect(entry.summary).toBe('Login bug investigation');
        expect(entry.firstPrompt).toBe('look at auth.ts');
    });

    it('only reads the head of a large transcript', async () => {
        const big: object[] = [userLine('first prompt')];
        for (let i = 0; i < 2000; i++) big.push({ type: 'assistant', uuid: `a${i}`, message: { role: 'assistant', content: 'x'.repeat(200) } });
        await writeJsonl(projA, idA, big);
        const result = await listClaudeSessionHistory({ projectDirs: [projA], headBytes: 8192 });
        expect(result.entries[0].firstPrompt).toBe('first prompt');
        expect(result.entries[0].sizeBytes).toBeGreaterThan(8192);
    });

    it('parseClaudeHistoryHead truncates long prompts and tolerates a cut last line', () => {
        const head = JSON.stringify(userLine('a'.repeat(500))) + '\n{"type":"assistant","mess';
        const parsed = parseClaudeHistoryHead(head, 50);
        expect(parsed?.firstPrompt).toHaveLength(50);
        expect(parsed?.firstPrompt.endsWith('…')).toBe(true);
        expect(parseClaudeHistoryHead('', 50)).toBeNull();
    });
});
