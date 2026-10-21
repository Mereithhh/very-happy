import { describe, expect, it } from 'vitest';
import { attentionFromEvent, HUMAN_ATTENTION_TTL_MS, isAttentionFresh, useHumanAttention } from './humanAttention';

describe('B-510 human attention', () => {
    it('only attention events count, and only in-app urls are kept', () => {
        expect(attentionFromEvent({ kind: 'done', body: 'x', timestamp: 1 })).toBeNull();
        expect(attentionFromEvent({ kind: 'attention', body: 'scan QR', url: '/machine/m/panel/p', timestamp: 5 })).toEqual({ reason: 'scan QR', url: '/machine/m/panel/p', at: 5 });
        expect(attentionFromEvent({ kind: 'attention', body: 'x', url: 'https://evil.example', timestamp: 5 })?.url).toBeNull();
        expect(attentionFromEvent({ kind: 'attention', body: 'x', url: '//evil.example', timestamp: 5 })?.url).toBeNull();
    });

    it('expires after the TTL; report / dismiss per session', () => {
        const a = { reason: 'r', url: null, at: 1_000 };
        expect(isAttentionFresh(a, 1_000 + HUMAN_ATTENTION_TTL_MS - 1)).toBe(true);
        expect(isAttentionFresh(a, 1_000 + HUMAN_ATTENTION_TTL_MS)).toBe(false);
        useHumanAttention.getState().report('s1', a);
        useHumanAttention.getState().report('s2', a);
        useHumanAttention.getState().dismiss('s1');
        expect(Object.keys(useHumanAttention.getState().bySession)).toEqual(['s2']);
    });
});
