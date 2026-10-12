import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
    clearIndexDir,
    enforceTextCap,
    indexFilePath,
    loadIndex,
    parseIndex,
    planFile,
    saveIndex,
    serializeIndex,
    type FileRecord,
} from './store';

function record(path: string, mtimeMs: number, text: string): FileRecord {
    return {
        path, agent: 'claude', id: path, ino: 1, size: 10, mtimeMs, offset: 10,
        meta: { cwd: '/x', firstPrompt: path }, msgs: [{ r: 'u', x: text }], chars: text.length,
    };
}

describe('planFile (B-549)', () => {
    const prev = { ino: 7, size: 100, mtimeMs: 1, offset: 90 };
    it('new file → reread; unchanged → skip; clean growth → append', () => {
        expect(planFile(undefined, { ino: 7, size: 5, mtimeMs: 1 })).toBe('reread');
        expect(planFile(prev, { ino: 7, size: 100, mtimeMs: 1 })).toBe('skip');
        expect(planFile(prev, { ino: 7, size: 150, mtimeMs: 2 })).toBe('append');
    });
    it('anything but an append re-reads from the start', () => {
        expect(planFile(prev, { ino: 8, size: 150, mtimeMs: 2 })).toBe('reread'); // replaced file
        expect(planFile(prev, { ino: 7, size: 80, mtimeMs: 2 })).toBe('reread'); // truncated below cursor
        expect(planFile(prev, { ino: 7, size: 95, mtimeMs: 2 })).toBe('reread'); // shrank
        expect(planFile(prev, { ino: 7, size: 100, mtimeMs: 2 })).toBe('reread'); // same-size rewrite
        expect(planFile({ ...prev, evicted: true }, { ino: 7, size: 150, mtimeMs: 2 })).toBe('reread');
    });
});

describe('enforceTextCap (B-549)', () => {
    it('drops the text of the oldest sessions first, keeping metadata', () => {
        const records = new Map<string, FileRecord>([
            ['a', record('a', 1, 'x'.repeat(40))],
            ['b', record('b', 3, 'y'.repeat(40))],
            ['c', record('c', 2, 'z'.repeat(40))],
        ]);
        expect(enforceTextCap(records, 100)).toBe(1);
        expect(records.get('a')).toMatchObject({ evicted: true, chars: 0, msgs: [], meta: { firstPrompt: 'a' } });
        expect(records.get('b')!.chars).toBe(40);
        expect(enforceTextCap(records, 100)).toBe(0);
        expect(enforceTextCap(records, 10)).toBe(2);
    });
});

describe('index persistence (B-549)', () => {
    let dir: string;
    beforeEach(async () => { dir = join(await mkdtemp(join(tmpdir(), 'vh-hs-store-')), 'history-search'); });
    afterEach(async () => { await rm(join(dir, '..'), { recursive: true, force: true }); });

    it('round-trips through disk with private permissions', async () => {
        const records = [record('/p/a.jsonl', 1, 'hello'), record('/p/b.jsonl', 2, '世界')];
        await saveIndex(dir, records, 1234);
        const loaded = await loadIndex(dir);
        expect(loaded?.savedAt).toBe(1234);
        expect([...loaded!.records.values()]).toEqual(records);
        if (process.platform !== 'win32') {
            expect((await stat(indexFilePath(dir))).mode & 0o777).toBe(0o600);
            expect((await stat(dir)).mode & 0o777).toBe(0o700);
        }
    });

    it('treats a missing, foreign-version or garbled index as empty', async () => {
        expect(await loadIndex(dir)).toBeNull();
        expect(parseIndex(serializeIndex([], 1).replace('"v":1', '"v":99'))).toBeNull();
        expect(parseIndex('not json')).toBeNull();
        const partial = parseIndex(`${JSON.stringify({ v: 1, savedAt: 5 })}\n{"path":1}\n${JSON.stringify(record('/ok', 1, 'x'))}\n{torn`);
        expect([...partial!.records.keys()]).toEqual(['/ok']);
    });

    it('clear removes the directory', async () => {
        await saveIndex(dir, [record('/p/a.jsonl', 1, 'hello')], 1);
        await clearIndexDir(dir);
        await expect(readFile(indexFilePath(dir))).rejects.toThrow();
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, 'stray'), 'x');
        await clearIndexDir(dir);
        await expect(stat(dir)).rejects.toThrow();
    });
});
