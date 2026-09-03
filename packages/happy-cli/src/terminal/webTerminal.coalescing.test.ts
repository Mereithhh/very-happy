/**
 * B-334 — 合并层的**接线**回归（合并规则本身在 outputCoalescer.test.ts）。
 *
 * 这里是源码断言型测试，因为要钉住的四条全是「顺序/位置」约束，行为测试恰恰
 * 看不见它们：缓冲里的字节还没有 seq，任何一处漏 flush 都不会报错，只会在
 * 线上表现成「重画一遍」「宽度错一拍」「最后一屏丢了」。四条：
 *
 *  ① 两条 transport 的 live 输出都必须走 `pushOutput`，不许再直接 `ingest`
 *     ——直接 ingest 就是把合并层绕过去了，也就退回 1029 帧。
 *  ② capture anchor 读 `session.seq` 之前必须 flush：anchor 之前打印的东西
 *     已经在 capture 里，它若拿到 > seqAtAnchor 的 seq，客户端会在 restore
 *     之上再画一遍。
 *  ③ `resizeHeadless` 改尺寸之前必须 flush：缓冲里的字节是按旧宽度产出的
 *     （也正是这条让几何 marker 不会排到早于它的字节前面）。
 *  ④ transport 退出时必须 flush，否则 shell 死前的最后一帧永远发不出去。
 *
 * 用 `node scripts/dev/mutation-check.mjs` 验过它真的钉得住。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'webTerminal.ts'), 'utf8');

describe('B-334 output coalescing wiring', () => {
    it('routes BOTH transports through pushOutput', () => {
        // control mode (%output) and the no-tmux pty fallback.
        expect(src).toContain('created.pushOutput(data);');
        expect(src).toContain("created.pushOutput(Buffer.from(data, 'utf8'));");
    });

    it('leaves ingest() for the synthetic geometry marker only', () => {
        // Every other ingest call site would bypass the coalescer — and would
        // also mean two code paths assigning seqs.
        const callSites = src.match(/\w+\.ingest\(/g) ?? [];
        expect(callSites).toEqual(['this.ingest(', 'created.ingest(']);
        expect(src).toContain('const marker = created.ingest(geometryMarker(size.cols, size.rows));');
    });

    it('flushes at the capture anchor before reading the baseline seq', () => {
        const anchor = src.slice(src.indexOf("onBlock: c.key === 'anchor'"));
        const flushAt = anchor.indexOf('session.flushOutput();');
        const readAt = anchor.indexOf('seqAtAnchor = session.seq;');
        expect(flushAt).toBeGreaterThan(0);
        expect(flushAt).toBeLessThan(readAt);
    });

    it('flushes inside resizeHeadless before the new geometry is applied', () => {
        const body = src.slice(src.indexOf('resizeHeadless(cols: number, rows: number) {'));
        const flushAt = body.indexOf('this.flushOutput();');
        const assignAt = body.indexOf('this.cols = cols;');
        expect(flushAt).toBeGreaterThan(0);
        expect(flushAt).toBeLessThan(assignAt);
    });

    it('flushes the tail on both transports’ exit, before the session is dropped', () => {
        for (const marker of ['onExit: (code) => {', 'proc.onExit(({ exitCode }) => {']) {
            const body = src.slice(src.indexOf(marker));
            const flushAt = body.indexOf('flushOutput();');
            const deleteAt = body.indexOf('this.terminals.delete(id);');
            expect(flushAt).toBeGreaterThan(0);
            expect(flushAt).toBeLessThan(deleteAt);
        }
    });

    it('cancels the pending flush timer when the session is disposed', () => {
        const body = src.slice(src.indexOf('    dispose() {'));
        expect(body.slice(0, 600)).toContain('this.clearFlushTimer();');
    });

    it('never lets a coalescing timer hold the daemon process open', () => {
        expect(src).toContain('timer.unref?.();');
    });
});
