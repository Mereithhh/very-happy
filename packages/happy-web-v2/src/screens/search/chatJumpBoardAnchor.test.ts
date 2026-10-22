// @vitest-environment happy-dom
/**
 * B-766: 汇报板 「在消息流中定位」 — an Owner item is anchored by its client
 * localId, a lead item by the agent message id; agent messages now carry
 * `data-message-id` so the jump lands on the reply itself, not its turn prompt.
 */
import { describe, expect, it } from 'vitest';
import type { Message } from '@/sync/typesMessage';
import { findJumpMessage } from './chatJump';
import { locateJumpTarget } from './useChatJump';

const chron = [
    { kind: 'user-text', id: 'u1', localId: 'owner-q1', createdAt: 10, text: 'when can we ship?' },
    { kind: 'agent-text', id: 'a1', localId: null, createdAt: 11, text: 'tests are running' },
    { kind: 'user-text', id: 'u2', localId: 'owner-q2', createdAt: 20, text: 'who writes the notes?' },
    { kind: 'agent-text', id: 'a2', localId: null, createdAt: 21, text: 'later today' },
] as unknown as Message[];

describe('board anchors', () => {
    it('an Owner message is found by localId, with no search terms', () => {
        expect(findJumpMessage(chron, { terms: [], localId: 'owner-q2' })).toBe('u2');
        expect(findJumpMessage(chron, { terms: [], localId: 'missing' })).toBeNull();
        expect(findJumpMessage(chron, { terms: [], messageId: 'a1' })).toBe('a1');
    });

    it('lands on the agent message element itself via data-message-id', () => {
        const root = document.createElement('div');
        root.innerHTML = `
            <div class="msg msg--user" data-chat-prompt-id="u1" data-message-id="u1">when can we ship?</div>
            <div class="msg msg--agent" data-message-id="a1"><p>tests are running</p></div>
            <div class="msg msg--user" data-chat-prompt-id="u2" data-message-id="u2">who writes the notes?</div>
            <div class="msg msg--agent" data-message-id="a2"><p>later today</p></div>`;
        document.body.appendChild(root);
        const found = locateJumpTarget(root, chron, 'a1', { terms: [], messageId: 'a1' });
        expect(found?.el.getAttribute('data-message-id')).toBe('a1');
        // (happy-dom's TreeWalker yields no text nodes, so the highlight scope is checked in the browser probe.)
        expect(found?.el.textContent).toBe('tests are running');
    });

    it('without the anchor attribute it still falls back to the turn prompt', () => {
        const root = document.createElement('div');
        root.innerHTML = `
            <div class="msg msg--user" data-chat-prompt-id="u1">when can we ship?</div>
            <div class="activity">collapsed</div>`;
        const found = locateJumpTarget(root, chron, 'a1', { terms: [], messageId: 'a1' });
        expect(found?.el.getAttribute('data-chat-prompt-id')).toBe('u1');
    });
});
