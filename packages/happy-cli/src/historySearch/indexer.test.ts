import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFile, mkdir, mkdtemp, rename, rm, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readCompleteLines, refreshRecords, type HistoryRoots } from './indexer';
import type { FileRecord } from './store';

const claudeId = '11111111-2222-4333-8444-555555555555';
const claudeId2 = '11111111-2222-4333-8444-666666666666';
const codexId = '01a0637d-bfdd-7423-8da5-3eea15ca8dd7';
const j = (v: unknown) => JSON.stringify(v) + '\n';

const user = (text: string, cwd = '/work/app') => j({ type: 'user', cwd, timestamp: '2026-09-01T00:00:00Z', message: { content: text } });
const assistant = (text: string) => j({ type: 'assistant', message: { content: [{ type: 'text', text }] } });

describe('readCompleteLines (B-549)', () => {
    let dir: string;
    beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'vh-hs-read-')); });
    afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

    it('never commits an unterminated tail line and resumes exactly there', async () => {
        const file = join(dir, 'a.jsonl');
        await writeFile(file, 'one\ntwo\nthr');
        const seen: string[] = [];
        const end = await readCompleteLines(file, 0, (l) => seen.push(l));
        expect(seen).toEqual(['one', 'two']);
        expect(end).toBe(8);
        await appendFile(file, 'ee\nfour\r\n');
        const more: string[] = [];
        const end2 = await readCompleteLines(file, end, (l) => more.push(l));
        expect(more).toEqual(['three', 'four']);
        expect(end2).toBe(Buffer.byteLength('one\ntwo\nthree\nfour\r\n'));
    });

    it('skips an over-long line without decoding it but moves past it', async () => {
        const file = join(dir, 'b.jsonl');
        await writeFile(file, `short\n${'x'.repeat(5000)}\nafter\n`);
        const seen: string[] = [];
        const end = await readCompleteLines(file, 0, (l) => seen.push(l), 1000);
        expect(seen).toEqual(['short', 'after']);
        expect(end).toBe(6 + 5001 + 6);
    });

    it('decodes multi-byte text split across chunk boundaries', async () => {
        const file = join(dir, 'c.jsonl');
        const line = '中文'.repeat(300_000); // 1.8 MB: spans two 1 MiB chunks, under the line cap
        await writeFile(file, `${line}\n`);
        const seen: string[] = [];
        await readCompleteLines(file, 0, (l) => seen.push(l));
        expect(seen).toEqual([line]);
    });
});

describe('refreshRecords (B-549)', () => {
    let root: string;
    let roots: HistoryRoots;
    let claudeFile: string;
    let codexFile: string;

    beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), 'vh-hs-refresh-'));
        roots = {
            claudeProjectsRoot: join(root, 'claude', 'projects'),
            codexSessionsRoot: join(root, 'codex', 'sessions'),
            codexIndexPath: join(root, 'codex', 'session_index.jsonl'),
        };
        const proj = join(roots.claudeProjectsRoot, '-work-app');
        await mkdir(join(proj, claudeId, 'subagents'), { recursive: true });
        claudeFile = join(proj, `${claudeId}.jsonl`);
        await writeFile(claudeFile, user('first question about relay') + assistant('relay answer'));
        // Side-chain transcripts and non-UUID files are not conversations.
        await writeFile(join(proj, claudeId, 'subagents', `agent-x.jsonl`), user('sub agent'));
        await writeFile(join(proj, 'notes.jsonl'), user('not a uuid'));
        const day = join(roots.codexSessionsRoot, '2026', '09', '02');
        await mkdir(day, { recursive: true });
        codexFile = join(day, `rollout-2026-09-02T00-00-00-${codexId}.jsonl`);
        await writeFile(codexFile, j({ type: 'session_meta', payload: { id: codexId, cwd: '/work/codex', originator: 'codex-tui' } })
            + j({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'codex question' }] } }));
        await writeFile(roots.codexIndexPath, j({ id: codexId, thread_name: 'Codex thread name' }));
    });
    afterEach(async () => { await rm(root, { recursive: true, force: true }); });

    async function pass(records: Map<string, FileRecord>, maxTextChars = 1_000_000) {
        return refreshRecords(records, { roots, maxTextChars });
    }

    it('builds from scratch, then reads only appended bytes', async () => {
        const records = new Map<string, FileRecord>();
        const first = await pass(records);
        expect(first).toMatchObject({ changed: true, cancelled: false, filesTotal: 2 });
        expect([...records.keys()].sort()).toEqual([claudeFile, codexFile].sort());
        const c = records.get(claudeFile)!;
        expect(c.msgs.map((m) => m.x)).toEqual(['first question about relay', 'relay answer']);
        expect(records.get(codexFile)!.meta.summary).toBe('Codex thread name');

        const again = await pass(records);
        expect(again.changed).toBe(false);

        // Append a complete line plus a half-written one.
        await appendFile(claudeFile, assistant('follow-up') + '{"type":"assistant","message":{"content":"half');
        await utimes(claudeFile, new Date(), new Date(Date.now() + 5000));
        await pass(records);
        const grown = records.get(claudeFile)!;
        expect(grown.msgs.map((m) => m.x)).toEqual(['first question about relay', 'relay answer', 'follow-up']);
        // The torn line is finished later and then indexed exactly once.
        await appendFile(claudeFile, ' done"}}\n');
        await utimes(claudeFile, new Date(), new Date(Date.now() + 10000));
        await pass(records);
        expect(records.get(claudeFile)!.msgs.map((m) => m.x)).toEqual(['first question about relay', 'relay answer', 'follow-up', 'half done']);
    });

    it('re-reads a replaced file and drops deleted files and files under a root that moved', async () => {
        const records = new Map<string, FileRecord>();
        await pass(records);
        // Replace with different content (new inode).
        const tmp = `${claudeFile}.new`;
        await writeFile(tmp, user('rewritten'));
        await rename(tmp, claudeFile);
        await pass(records);
        expect(records.get(claudeFile)!.msgs.map((m) => m.x)).toEqual(['rewritten']);

        await rm(codexFile);
        await pass(records);
        expect(records.has(codexFile)).toBe(false);

        // agent-home moved: the old root's records leave the index.
        const other = join(root, 'other-claude', 'projects');
        await mkdir(join(other, '-w'), { recursive: true });
        const moved = join(other, '-w', `${claudeId2}.jsonl`);
        await writeFile(moved, user('moved home', '/w'));
        roots = { ...roots, claudeProjectsRoot: other };
        await pass(records);
        expect([...records.keys()]).toEqual([moved]);
    });

    it('enforces the text cap and stops when cancelled', async () => {
        const records = new Map<string, FileRecord>();
        const result = await pass(records, 5);
        expect(result.evicted).toBeGreaterThan(0);
        expect([...records.values()].reduce((n, r) => n + r.chars, 0)).toBeLessThanOrEqual(5);

        const fresh = new Map<string, FileRecord>();
        const cancelled = await refreshRecords(fresh, { roots, maxTextChars: 1e6, isCancelled: () => true });
        expect(cancelled.cancelled).toBe(true);
        expect(fresh.size).toBe(0);
    });
});
