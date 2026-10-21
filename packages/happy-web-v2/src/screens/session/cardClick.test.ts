// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { cardClickOpens } from './cardClick';

describe('cardClickOpens (B-716)', () => {
    const card = document.createElement('div');
    card.innerHTML = '<span class="head">who</span><a href="/x"><svg></svg></a><button type="button">open</button>';
    it('a click on plain card content opens the reader', () => {
        expect(cardClickOpens({ target: card.querySelector('.head') }, '')).toBe(true);
        expect(cardClickOpens({ target: card }, '')).toBe(true);
    });
    it('links and buttons inside the card keep their own action', () => {
        expect(cardClickOpens({ target: card.querySelector('svg') }, '')).toBe(false);
        expect(cardClickOpens({ target: card.querySelector('button') }, '')).toBe(false);
    });
    it('finishing a text selection does not open it', () => {
        expect(cardClickOpens({ target: card.querySelector('.head') }, 'who')).toBe(false);
    });
});
