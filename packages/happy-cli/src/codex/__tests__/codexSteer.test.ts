/**
 * B-628: a user message sent with `delivery: 'steer'` goes into the running Codex
 * turn (`client.steerTurn` → `turn/steer`) and only falls back to the queue when
 * Codex did not take it; the wrapper advertises the capability the web gates the
 * Steer button on; a steered message the turn never read gets the B-332 tombstone.
 * Source assertions on runCodex.ts, verified with scripts/dev/mutation-check.mjs.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { CODEX_STEER_CAPABILITY } from '@slopus/happy-wire';

const source = readFileSync(new URL('../runCodex.ts', import.meta.url), 'utf8')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\n(?:[ \t]*\n)+/g, '\n');

describe('Codex steer (B-628)', () => {
    it('advertises codex-steer-v1 so the web offers Steer only to a wrapper that has it', () => {
        expect(CODEX_STEER_CAPABILITY).toBe('codex-steer-v1');
        expect(source).toContain('capabilities: [PROMPT_QUEUE_CAPABILITY, FORK_BACKFILL_CAPABILITY, HIBERNATION_CAPABILITY, CODEX_STEER_CAPABILITY]');
    });

    it('tries the running turn first for a delivery=steer message, and queues it otherwise', () => {
        const steerAt = source.indexOf("if (message.meta?.delivery === 'steer' && !isCodexClearText(message.content.text)) {");
        expect(steerAt).toBeGreaterThan(0);
        expect(source.slice(steerAt, steerAt + 300)).toContain('if (await steerIntoRunningTurn(message.content.text, attachments, message.localKey)) {');
        expect(source.slice(steerAt, steerAt + 400)).toContain('return;');
        // The ordinary queue push comes after, as the fallback for everything else.
        const enqueueAt = source.indexOf('const enqueueResult = enqueueCodexUserText({');
        expect(enqueueAt).toBeGreaterThan(steerAt);
    });

    it('only steers while the wrapper owns a turn, and treats anything but `steered` as not delivered', () => {
        const fnAt = source.indexOf('const steerIntoRunningTurn = async (');
        expect(fnAt).toBeGreaterThan(0);
        const body = source.slice(fnAt, fnAt + 1600);
        expect(body).toContain('if (!turnActive || abortInProgress || shouldExit) return false;');
        expect(body).toContain("if (outcome === 'steered') {");
        expect(body).toContain('return true;');
        // Staged attachment copies of a message that fell back to the queue are removed again.
        expect(body).toContain('unlink(file.path)');
        expect(body).toContain('return false;');
    });

    it('tombstones a steered message the turn ended without reading', () => {
        const at = source.indexOf("} else if (msg.type === 'steer_dropped') {");
        expect(at).toBeGreaterThan(0);
        expect(source.slice(at, at + 500)).toContain("session.sendQueueCancelReason(clientIds, 'aborted');");
    });
});
