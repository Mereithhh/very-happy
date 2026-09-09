import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const input = readFileSync(new URL('./input.css', import.meta.url), 'utf8');
const session = readFileSync(new URL('./session.css', import.meta.url), 'utf8');
const component = readFileSync(new URL('./AgentInput.tsx', import.meta.url), 'utf8');

describe('mobile composer layout contract', () => {
    it('holds delivery while editing and exposes explicit retry after failure', () => {
        expect(component).toContain('canReleaseQueuedMessage(deliveryPhaseRef.current, isWorking, releaseGate, editingId !== null)');
        expect(component).toContain("deliveryPhaseRef.current === 'failed' && <div className=\"ci-queue-failure\"");
        expect(component).toContain("await deliverQueuedMessage(() => sync.sendMessage(sessionId, item.text, {");
    });
    it('keeps the same two controls visible with touch-sized targets', () => {
        expect(input).toMatch(/\.ci-composer \.mm-trigger, \.ci-steer \{ min-width: 44px; min-height: 44px; \}/);
        expect(component).toContain('<ModelEffortMenu');
        expect(component).not.toContain('<SessionOptionsDialog');
    });

    it('gives the text its own row and keeps controls in a fixed toolbar below it', () => {
        expect(component).toContain('<div className="ci-composer-toolbar" data-working={isWorking && canSend}>');
        expect(component).toContain('<div className="ci-composer-tools">');
        expect(input).toMatch(/\.ci-textarea \{[\s\S]*grid-row: 1;[\s\S]*min-height: 72px;/);
        expect(input).toMatch(/\.ci-composer-toolbar \{[\s\S]*grid-row: 2;[\s\S]*justify-content: space-between;/);
    });

    it('keeps send available beside stop while an agent is working', () => {
        expect(component).toContain('<div className="ci-composer-actions">');
        expect(component).toMatch(/\{isWorking && \([\s\S]*ci-send--abort[\s\S]*\)\}[\s\S]*aria-label=\{gate === 'restore-first' \? t\('restore\.restoreAndSend'\) : isWorking \? t\('session\.chat\.queueSend'\) : t\('session\.chat\.send'\)\}/);
        expect(input).toMatch(/\.ci-composer-actions \{[\s\S]*display: inline-flex;/);
    });

    it('makes exact context usage available in a popover', () => {
        expect(component).toContain('`${contextSize.toLocaleString()} / ${contextWindow.toLocaleString()}`');
        expect(input).toMatch(/\.ci-meter \{[\s\S]*margin-inline-start: auto;[\s\S]*white-space: nowrap;/);
    });

    it('clips transcript painting at the in-flow footer boundary during keyboard resize', () => {
        expect(session).toMatch(/\.sd-body \{[\s\S]*overflow: hidden;/);
        expect(session).toMatch(/\.sd-foot \{[\s\S]*position: relative;[\s\S]*z-index: 1;/);
        expect(session).toContain(".sd[data-keyboard-open='true']");
    });
});
