import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, rm, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import {
    listCodexSessionHistory,
    parseCodexHistoryHead,
    parseCodexSessionIndex,
    VERY_HAPPY_CODEX_ORIGINATOR,
} from './codexSessionHistory';

const idA = '01a0637d-bfdd-7423-8da5-3eea15ca8dd7';
const idB = '01a0637e-5a8e-78a2-986e-d244ae69098f';
const idC = '01a06380-0566-7761-8c64-f23768ab99ed';
const idD = '01a09afe-bb1c-73c3-bd84-a16ed6729129';

function meta(id: string, extra: Record<string, unknown> = {}) {
    return {
        timestamp: '2026-09-02T18:59:40.958Z',
        type: 'session_meta',
        payload: {
            id,
            timestamp: '2026-09-02T18:59:40.652Z',
            cwd: '/work/app',
            originator: 'codex-tui',
            cli_version: '0.154.0',
            source: 'cli',
            model_provider: 'openai',
            base_instructions: { text: 'x'.repeat(2000) },
            git: { commit_hash: 'abc', branch: 'main', repository_url: 'git@example.com:a/b.git' },
            ...extra,
        },
    };
}
const harnessUser = {
    type: 'response_item',
    payload: { type: 'message', role: 'user', content: [
        { type: 'input_text', text: '# AGENTS.md instructions for /work/app\n\n<INSTRUCTIONS>\nbe nice\n</INSTRUCTIONS>' },
        { type: 'input_text', text: '<environment_context>\n  <cwd>/work/app</cwd>\n</environment_context>' },
    ] },
};
const developer = { type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'dev' }] } };
function userItem(text: string) {
    return { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } };
}
function userEvent(text: string) {
    return { type: 'event_msg', payload: { type: 'user_message', message: text, images: [] } };
}
function userCompleted(text: string) {
    return { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', id: 'u1', content: [{ type: 'text', text }] } } };
}

describe('codexSessionHistory', () => {
    let root: string;
    let sessions: string;

    beforeEach(async () => {
        root = join(tmpdir(), `codex-history-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        sessions = join(root, 'sessions');
        await mkdir(join(sessions, '2026', '09', '03'), { recursive: true });
        await mkdir(join(sessions, '2026', '09', '13'), { recursive: true });
        await writeFile(join(sessions, 'stray.txt'), 'x');
    });

    afterEach(async () => {
        if (existsSync(root)) await rm(root, { recursive: true, force: true });
    });

    async function writeRollout(day: string, id: string, lines: object[], mtimeSec?: number) {
        const path = join(sessions, '2026', '09', day, `rollout-2026-09-${day}T02-59-40-${id}.jsonl`);
        await writeFile(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf-8');
        if (mtimeSec !== undefined) await utimes(path, mtimeSec, mtimeSec);
        return path;
    }

    describe('parseCodexHistoryHead', () => {
        it('takes the clean user_message event over the harness-prefixed user items', () => {
            const head = [meta(idA), developer, harnessUser, userItem('Fix the login bug\nplease'), userEvent('Fix the login bug\nplease')]
                .map((l) => JSON.stringify(l)).join('\n');
            expect(parseCodexHistoryHead(head, 200)).toEqual({
                id: idA,
                cwd: '/work/app',
                firstPrompt: 'Fix the login bug please',
                startedAt: Date.parse('2026-09-02T18:59:40.652Z'),
                entrypoint: 'cli',
                originator: 'codex-tui',
                gitBranch: 'main',
                version: '0.154.0',
            });
        });

        it('reads the 0.154 item_completed UserMessage shape', () => {
            const head = [meta(idD, { source: 'vscode', originator: 'Codex Desktop', git: undefined }), harnessUser, userItem('hello'), userCompleted('hello')]
                .map((l) => JSON.stringify(l)).join('\n');
            expect(parseCodexHistoryHead(head, 200)).toMatchObject({ id: idD, firstPrompt: 'hello', entrypoint: 'vscode', originator: 'Codex Desktop' });
            expect(parseCodexHistoryHead(head, 200)).not.toHaveProperty('gitBranch');
        });

        it('falls back to the first non-harness user item when no event carries the prompt', () => {
            const head = [meta(idA), harnessUser, userItem('  Write   docs  ')].map((l) => JSON.stringify(l)).join('\n');
            expect(parseCodexHistoryHead(head, 200)?.firstPrompt).toBe('Write docs');
        });

        it('truncates long prompts and survives a cut last line', () => {
            const long = 'a'.repeat(500);
            const head = [meta(idA), userEvent(long)].map((l) => JSON.stringify(l)).join('\n') + '\n{"type":"event_msg","pay';
            const parsed = parseCodexHistoryHead(head, 50);
            expect(parsed?.firstPrompt).toHaveLength(50);
            expect(parsed?.firstPrompt.endsWith('…')).toBe(true);
        });

        it('rejects files that are not rollouts, have no cwd, or have no prompt', () => {
            expect(parseCodexHistoryHead(JSON.stringify(userEvent('x')), 200)).toBeNull();
            expect(parseCodexHistoryHead([meta(idA, { cwd: '' }), userEvent('x')].map((l) => JSON.stringify(l)).join('\n'), 200)).toBeNull();
            expect(parseCodexHistoryHead([meta(idA), developer, harnessUser].map((l) => JSON.stringify(l)).join('\n'), 200)).toBeNull();
            expect(parseCodexHistoryHead('', 200)).toBeNull();
        });
    });

    it('parses session_index.jsonl names tolerantly', () => {
        const names = parseCodexSessionIndex([
            JSON.stringify({ id: idA.toUpperCase(), thread_name: ' 配置开发环境 ', updated_at: 'x' }),
            JSON.stringify({ id: 'nope', thread_name: 'x' }),
            JSON.stringify({ id: idB, thread_name: '   ' }),
            'garbage',
            '',
        ].join('\n'));
        expect([...names.entries()]).toEqual([[idA, '配置开发环境']]);
    });

    it('lists newest first with index names, skips very-happy threads, honours exclude/limit/directory', async () => {
        await writeRollout('03', idA, [meta(idA), harnessUser, userEvent('oldest prompt')], 1000);
        await writeRollout('13', idB, [meta(idB, { cwd: '/work/other', source: 'exec', originator: 'codex_exec' }), userEvent('exec prompt')], 3000);
        await writeRollout('13', idC, [meta(idC, { originator: VERY_HAPPY_CODEX_ORIGINATOR, source: 'vscode' }), userEvent('ours')], 4000);
        await writeRollout('13', idD, [meta(idD), harnessUser, userItem('newest prompt'), userCompleted('newest prompt')], 2000);
        await writeFile(join(root, 'session_index.jsonl'), JSON.stringify({ id: idD, thread_name: 'Named thread' }) + '\n');

        const all = await listCodexSessionHistory({ sessionsRoot: sessions, sessionIndexPath: join(root, 'session_index.jsonl') });
        expect(all.truncated).toBe(false);
        expect(all.entries.map((e) => e.codexThreadId)).toEqual([idB, idD, idA]);
        expect(all.entries[1]).toMatchObject({ codexThreadId: idD, summary: 'Named thread', firstPrompt: 'newest prompt', sizeBytes: expect.any(Number) });
        expect(all.entries[0]).toMatchObject({ cwd: '/work/other', entrypoint: 'exec', originator: 'codex_exec', updatedAt: 3000_000 });
        expect(all.entries[2]).not.toHaveProperty('summary');

        const limited = await listCodexSessionHistory({ sessionsRoot: sessions, limit: 1 });
        expect(limited.entries.map((e) => e.codexThreadId)).toEqual([idB]);
        expect(limited.truncated).toBe(true);

        const excluded = await listCodexSessionHistory({ sessionsRoot: sessions, exclude: [idB.toUpperCase()] });
        expect(excluded.entries.map((e) => e.codexThreadId)).toEqual([idD, idA]);

        const scoped = await listCodexSessionHistory({ sessionsRoot: sessions, directory: '/work/other' });
        expect(scoped.entries.map((e) => e.codexThreadId)).toEqual([idB]);

        expect((await listCodexSessionHistory({ sessionsRoot: join(root, 'missing') })).entries).toEqual([]);
    });

    it('keeps one row per thread id when the same thread has two rollout files', async () => {
        await writeRollout('03', idA, [meta(idA), userEvent('first file')], 1000);
        await writeRollout('13', idA, [meta(idA), userEvent('resumed file')], 2000);
        const result = await listCodexSessionHistory({ sessionsRoot: sessions });
        expect(result.entries).toHaveLength(1);
        expect(result.entries[0].firstPrompt).toBe('resumed file');
    });
});
