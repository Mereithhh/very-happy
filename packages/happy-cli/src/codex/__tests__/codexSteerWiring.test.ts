/**
 * B-628 wiring in runCodex.ts: a user message sent with `delivery: 'steer'` is offered to
 * the running turn first (codexSteer.ts, whose behaviour has its own executable tests) and
 * queued only when it was not taken; the wrapper advertises the capability the web gates the
 * Steer button on; a steered message the turn never read gets the B-332 tombstone.
 * Source assertions, verified with scripts/dev/mutation-check.mjs.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { CODEX_STEER_CAPABILITY } from '@slopus/happy-wire';

const source = readFileSync(new URL('../runCodex.ts', import.meta.url), 'utf8')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\n(?:[ \t]*\n)+/g, '\n');

describe('Codex steer wiring (B-628)', () => {
    it('advertises codex-steer-v1 so the web offers Steer only to a wrapper that has it', () => {
        expect(CODEX_STEER_CAPABILITY).toBe('codex-steer-v1');
        expect(source).toContain('capabilities: [PROMPT_QUEUE_CAPABILITY, FORK_BACKFILL_CAPABILITY, HIBERNATION_CAPABILITY, AUTO_RESTART_CAPABILITY, CODEX_STEER_CAPABILITY, PROJECT_SESSION_CAPABILITY, CODEX_COMPACT_CAPABILITY]');
    });

    it('tries the running turn first for a delivery=steer message, and queues it otherwise', () => {
        const steerAt = source.indexOf("if (message.meta?.delivery === 'steer' && !isCodexControlText(message.content.text)) {");
        expect(steerAt).toBeGreaterThan(0);
        expect(source.slice(steerAt, steerAt + 300)).toContain('if (await steerIntoRunningTurn(steerDeps, message.content.text, attachments, message.localKey)) {');
        expect(source.slice(steerAt, steerAt + 400)).toContain('return;');
        // The ordinary queue push comes after, as the fallback for everything else.
        const enqueueAt = source.indexOf('const enqueueResult = enqueueCodexUserText({');
        expect(enqueueAt).toBeGreaterThan(steerAt);
    });

    it('only steers while the wrapper owns a turn and nothing is aborting or exiting', () => {
        expect(source).toContain('ownsTurn: () => turnActive && !abortInProgress && !shouldExit,');
        // The steer goes through the app-server client, with the staged file manifest and image paths.
        expect(source).toContain('steer: (input: { text: string; images: string[]; clientId?: string }) => client.steerTurn(input),');
        expect(source).toContain('withAttachments: appendStagedAttachmentsToPrompt,');
    });

    it('tombstones a steered message the turn ended without reading', () => {
        const at = source.indexOf("} else if (msg.type === 'steer_dropped') {");
        expect(at).toBeGreaterThan(0);
        expect(source.slice(at, at + 500)).toContain("session.sendQueueCancelReason(clientIds, 'aborted');");
    });
});
