import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMirrorScanner, type MirrorScanner } from './mirrorScanner';
import type { RawJSONLines } from '@/claude/types';

const userLine = (uuid: string, text: string) =>
    JSON.stringify({ type: 'user', uuid, sessionId: 's', message: { content: text } }) + '\n';

function collector() {
    const messages: RawJSONLines[] = [];
    let truncated = 0;
    return {
        messages,
        get truncatedCount() { return truncated; },
        events: {
            onMessages: (msgs: RawJSONLines[]) => { messages.push(...msgs); },
            onBackfillTruncated: () => { truncated += 1; },
        },
    };
}

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
    const start = Date.now();
    while (!cond()) {
        if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
        await new Promise((r) => setTimeout(r, 25));
    }
}

describe('createMirrorScanner', () => {
    let dir: string;
    let scanner: MirrorScanner | null = null;

    afterEach(async () => {
        await scanner?.cleanup();
        scanner = null;
        rmSync(dir, { recursive: true, force: true });
    });

    it('backfill-tail replays only the last N messages and reports truncation', async () => {
        dir = mkdtempSync(join(tmpdir(), 'mirror-scan-'));
        const file = join(dir, 'a.jsonl');
        let content = '';
        for (let i = 0; i < 10; i++) content += userLine(`u${i}`, `msg ${i}`);
        writeFileSync(file, content);

        const c = collector();
        scanner = createMirrorScanner({ backfillLines: 3, events: c.events, pollIntervalMs: 50 });
        scanner.addFile(file, 'backfill-tail');

        await waitFor(() => c.messages.length >= 3);
        expect(c.messages.map((m) => (m as any).uuid)).toEqual(['u7', 'u8', 'u9']);
        expect(c.truncatedCount).toBe(1);

        // Appended lines keep flowing (mode degrades to plain tail).
        appendFileSync(file, userLine('u10', 'late'));
        await waitFor(() => c.messages.length >= 4);
        expect((c.messages[3] as any).uuid).toBe('u10');
    });

    it('from-eof skips the on-disk prefix and only emits future appends', async () => {
        dir = mkdtempSync(join(tmpdir(), 'mirror-scan-'));
        const file = join(dir, 'b.jsonl');
        writeFileSync(file, userLine('old1', 'history') + userLine('old2', 'history'));

        const c = collector();
        scanner = createMirrorScanner({ backfillLines: 500, events: c.events, pollIntervalMs: 50 });
        scanner.addFile(file, 'from-eof');

        // Give the scanner a beat to resolve the EOF offset, then append.
        await new Promise((r) => setTimeout(r, 150));
        appendFileSync(file, userLine('new1', 'fresh'));
        await waitFor(() => c.messages.length >= 1);
        expect(c.messages.map((m) => (m as any).uuid)).toEqual(['new1']);
    });

    it('holds back a partial trailing line until it completes', async () => {
        dir = mkdtempSync(join(tmpdir(), 'mirror-scan-'));
        const file = join(dir, 'c.jsonl');
        writeFileSync(file, userLine('u1', 'one'));

        const c = collector();
        scanner = createMirrorScanner({ backfillLines: 500, events: c.events, pollIntervalMs: 50 });
        scanner.addFile(file, 'backfill-tail');
        await waitFor(() => c.messages.length >= 1);

        const partial = JSON.stringify({ type: 'user', uuid: 'u2', message: { content: '中文' } });
        appendFileSync(file, partial.slice(0, 20)); // mid-line, no newline
        await new Promise((r) => setTimeout(r, 150));
        expect(c.messages.length).toBe(1);

        appendFileSync(file, partial.slice(20) + '\n');
        await waitFor(() => c.messages.length >= 2);
        expect((c.messages[1] as any).uuid).toBe('u2');
        expect((c.messages[1] as any).message.content).toBe('中文');
    });

    it('resets when the file shrinks (offset > size) instead of wedging', async () => {
        dir = mkdtempSync(join(tmpdir(), 'mirror-scan-'));
        const file = join(dir, 'd.jsonl');
        writeFileSync(file, userLine('u1', 'aaaa') + userLine('u2', 'bbbb'));

        const c = collector();
        scanner = createMirrorScanner({ backfillLines: 500, events: c.events, pollIntervalMs: 50 });
        scanner.addFile(file, 'backfill-tail');
        await waitFor(() => c.messages.length >= 2);

        writeFileSync(file, userLine('u3', 'replaced')); // shorter than the old offset
        await waitFor(() => c.messages.some((m) => (m as any).uuid === 'u3'));
    });
});

describe('late transcript (regression: 60s give-up killed live mirrors)', () => {
    it('waits out a transcript that appears late (claude writes nothing before the first user message)', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'mirror-scan-'));
        const file = join(dir, 'late.jsonl');
        // NOT created yet — the real-world shape of a freshly-opened claude.
        const c = collector();
        const scanner = createMirrorScanner({ backfillLines: 500, events: c.events, pollIntervalMs: 50 });
        try {
            scanner.addFile(file, 'backfill-tail');
            await new Promise((r) => setTimeout(r, 400)); // well past several polls
            expect(c.messages.length).toBe(0);

            writeFileSync(file, userLine('first', 'finally typed something'));
            await waitFor(() => c.messages.length >= 1);
            expect((c.messages[0] as any).uuid).toBe('first');
        } finally {
            await scanner.cleanup();
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
