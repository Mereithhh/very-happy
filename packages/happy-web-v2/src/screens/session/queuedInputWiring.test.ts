import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const chatList = readFileSync(new URL('./ChatList.tsx', import.meta.url), 'utf8');
const css = readFileSync(new URL('./chatlist.css', import.meta.url), 'utf8');
const syncSource = readFileSync(new URL('../../sync/sync.ts', import.meta.url), 'utf8');

describe('queued input UI wiring', () => {
    it('separates queued user input from transcript rows and renders an explicit queue', () => {
        expect(chatList).toContain("message.inputState === 'queued'");
        expect(chatList).toContain('message.inputState === undefined');
        expect(chatList).toContain('className="cl-queue"');
        expect(chatList).toContain("t('session.chat.queuedHint')");
        expect(chatList).toContain("message.tool.name === 'file'");
        expect(syncSource).toContain("...(queuedAt !== undefined ? { meta: { queuedAt } } : {})");
    });

    it('keeps the queue bounded above the composer and avoids jump-button overlap', () => {
        expect(css).toContain('max-height: min(30vh, 220px)');
        expect(css).toContain('.cl-queue-items');
        expect(chatList).toContain('showJump && queuedMessages.length === 0');
        expect(chatList).toContain('className="cl-queue-jump"');
    });

    it('keeps queue actions visible and wires true durable cancellation', () => {
        const inputCss = readFileSync(new URL('./input.css', import.meta.url), 'utf8');
        expect(inputCss).not.toMatch(/\.ci-queue-actions\s*\{[^}]*opacity:\s*0/s);
        expect(chatList).toContain('sessionCancelQueuedMessage');
        expect(chatList).toContain('className="cl-queue-cancel"');
        expect(chatList).toContain('cancelingLocalKey === message.localId ? <Spinner');
        expect(syncSource).toContain("ev: { t: 'queue-cancel', targetLocalKeys }");
    });
});
