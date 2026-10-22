// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import type { Message } from '@/sync/typesMessage';
import { locateJumpTarget } from './useChatJump';

// B-766: 「已答 ↗」 jumps through chatJump with the answer's id and no terms.
describe('chatJump lands on an anchored agent message', () => {
    const chronological = [
        { kind: 'user-text', id: 'q', localId: null, createdAt: 1, text: 'question' },
        { kind: 'agent-text', id: 'a', localId: null, createdAt: 2, text: 'the answer' },
    ] as Message[];
    const root = () => {
        const el = document.createElement('div');
        el.innerHTML = '<div class="msg msg--user" data-chat-prompt-id="q">question</div><div class="msg msg--agent" data-message-id="a">the answer</div>';
        return el;
    };
    it('goes straight to the data-message-id anchor', () => {
        const found = locateJumpTarget(root(), chronological, 'a', { terms: [], messageId: 'a', flash: true });
        expect(found?.el.getAttribute('data-message-id')).toBe('a');
        expect(found?.scope).toEqual([]);
    });
    it('without the anchor (answer folded away) it lands on the question', () => {
        const el = root();
        el.querySelector('[data-message-id]')!.removeAttribute('data-message-id');
        const found = locateJumpTarget(el, chronological, 'a', { terms: [], messageId: 'a', flash: true });
        expect(found?.el.getAttribute('data-chat-prompt-id')).toBe('q');
    });
});
