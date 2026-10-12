import { appendFile, mkdtemp, rename, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    TRANSCRIPT_BOUNDARY_BYTES,
    TranscriptPathHints,
    advanceTranscriptCursor,
    isValidTranscriptHint,
    planTranscriptRead,
    readTranscriptIncrement,
    type TranscriptCursor,
} from './transcriptCursor';

describe('planTranscriptRead / advanceTranscriptCursor (B-551, pure)', () => {
    const stat = { dev: 1, ino: 2, size: 100 };
    const cursor: TranscriptCursor = { offset: 80, dev: 1, ino: 2, boundary: Buffer.from('x'.repeat(10)) };

    it('starts at 0 without a cursor and appends from the offset with one', () => {
        expect(planTranscriptRead(null, stat)).toEqual({ start: 0, reset: null, verifyAt: null });
        expect(planTranscriptRead(cursor, stat)).toEqual({ start: 80, reset: null, verifyAt: 70 });
    });

    it('detects a replaced and a truncated file', () => {
        expect(planTranscriptRead(cursor, { ...stat, ino: 3 })).toMatchObject({ start: 0, reset: 'replaced' });
        expect(planTranscriptRead(cursor, { ...stat, dev: 9 })).toMatchObject({ start: 0, reset: 'replaced' });
        expect(planTranscriptRead(cursor, { ...stat, size: 79 })).toMatchObject({ start: 0, reset: 'truncated' });
    });

    it('consumes complete lines only and keeps a bounded boundary', () => {
        const { lines, cursor: next } = advanceTranscriptCursor(null, stat, 0, Buffer.from('{"a":1}\n\n{"b":2}\n{"partial'));
        expect(lines).toEqual(['{"a":1}', '{"b":2}']);
        expect(next.offset).toBe('{"a":1}\n\n{"b":2}\n'.length);
        expect(next.boundary.toString()).toBe('{"a":1}\n\n{"b":2}\n');
        const long = advanceTranscriptCursor(null, stat, 0, Buffer.from(`${'z'.repeat(200)}\n`)).cursor;
        expect(long.boundary.length).toBe(TRANSCRIPT_BOUNDARY_BYTES);
    });

    it('splits on the 0x0a byte, so multi-byte UTF-8 survives a partial read', () => {
        const bytes = Buffer.from('{"t":"中文"}\n{"t":"中');
        const { lines, cursor: next } = advanceTranscriptCursor(null, stat, 0, bytes.subarray(0, bytes.length - 1));
        expect(lines).toEqual(['{"t":"中文"}']);
        expect(next.offset).toBe(Buffer.byteLength('{"t":"中文"}\n'));
    });
});

describe('readTranscriptIncrement (B-551, real files)', () => {
    let dir: string;
    let file: string;

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'vh-cursor-'));
        file = join(dir, 's.jsonl');
    });
    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    it('returns null for a missing file', async () => {
        expect(await readTranscriptIncrement(file, null)).toBeNull();
    });

    it('reads appended lines once, waiting for a half-written line', async () => {
        await writeFile(file, '{"n":1}\n{"n":2}\n');
        const a = await readTranscriptIncrement(file, null);
        expect(a).toMatchObject({ lines: ['{"n":1}', '{"n":2}'], reset: null });
        await appendFile(file, '{"n":3');
        const b = await readTranscriptIncrement(file, a!.cursor);
        expect(b).toMatchObject({ lines: [], reset: null });
        await appendFile(file, '}\n');
        const c = await readTranscriptIncrement(file, b!.cursor);
        expect(c).toMatchObject({ lines: ['{"n":3}'], reset: null });
        const d = await readTranscriptIncrement(file, c!.cursor);
        expect(d).toMatchObject({ lines: [], reset: null });
    });

    it('re-reads from the start after truncation', async () => {
        await writeFile(file, '{"n":1}\n{"n":2}\n');
        const a = await readTranscriptIncrement(file, null);
        await truncate(file, 8);
        const b = await readTranscriptIncrement(file, a!.cursor);
        expect(b).toMatchObject({ lines: ['{"n":1}'], reset: 'truncated' });
    });

    it('re-reads from the start after the file is replaced', async () => {
        await writeFile(file, '{"n":1}\n');
        const a = await readTranscriptIncrement(file, null);
        const other = join(dir, 'other.jsonl');
        await writeFile(other, '{"n":1}\n{"n":9}\n');
        await rename(other, file);
        const b = await readTranscriptIncrement(file, a!.cursor);
        expect(b).toMatchObject({ lines: ['{"n":1}', '{"n":9}'], reset: 'replaced' });
    });

    it('detects an in-place rewrite that is not shorter (boundary mismatch)', async () => {
        await writeFile(file, '{"n":1}\n{"n":2}\n');
        const a = await readTranscriptIncrement(file, null);
        // Same inode, longer file, but the already-consumed bytes differ.
        await writeFile(file, '{"n":7}\n{"n":8}\n{"n":9}\n');
        const b = await readTranscriptIncrement(file, a!.cursor);
        expect(b).toMatchObject({ lines: ['{"n":7}', '{"n":8}', '{"n":9}'], reset: 'rewritten' });
    });
});

describe('transcript path hints (B-551)', () => {
    const id = '0b5c7c0e-1111-2222-3333-444455556666';

    it('accepts only an absolute path naming exactly this session', () => {
        expect(isValidTranscriptHint(id, `/home/u/.claude/projects/-x/${id}.jsonl`)).toBe(true);
        expect(isValidTranscriptHint(id, `relative/${id}.jsonl`)).toBe(false);
        expect(isValidTranscriptHint(id, '/home/u/.claude/projects/-x/other.jsonl')).toBe(false);
        expect(isValidTranscriptHint(id, undefined)).toBe(false);
        expect(isValidTranscriptHint(id, 42)).toBe(false);
    });

    it('stores valid hints, bounded', () => {
        const hints = new TranscriptPathHints(2);
        expect(hints.note('a', '/p/a.jsonl')).toBe(true);
        expect(hints.note('b', '/p/wrong.jsonl')).toBe(false);
        hints.note('b', '/p/b.jsonl');
        hints.note('c', '/p/c.jsonl');
        expect(hints.get('a')).toBeUndefined();
        expect(hints.get('b')).toBe('/p/b.jsonl');
        expect(hints.get('c')).toBe('/p/c.jsonl');
    });
});
