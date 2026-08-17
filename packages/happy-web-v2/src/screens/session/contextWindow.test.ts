import { describe, expect, it } from 'vitest';
import {
    DEFAULT_CONTEXT_WINDOW,
    LONG_CONTEXT_WINDOW,
    contextPercentOf,
    contextWindowFor,
} from './contextWindow';

describe('contextWindowFor', () => {
    it('识别 1M 变体的各种标记写法', () => {
        for (const id of [
            'claude-opus-5[1m]',
            'claude-opus-5-1m',
            'claude_opus_5_1m',
            'claude-sonnet-5:1m',
            'CLAUDE-OPUS-5[1M]',
        ]) {
            expect(contextWindowFor(id), id).toBe(LONG_CONTEXT_WINDOW);
        }
    });

    it('普通模型走标准窗口', () => {
        for (const id of [
            'claude-opus-4-5-20260101',
            'claude-sonnet-4-6',
            'claude-haiku-4-5-20251001',
        ]) {
            expect(contextWindowFor(id), id).toBe(DEFAULT_CONTEXT_WINDOW);
        }
    });

    it('不把裸 1m 子串当成 1M 变体（假阳性比漏判更糟）', () => {
        expect(contextWindowFor('claude-x1m-preview')).toBe(DEFAULT_CONTEXT_WINDOW);
        expect(contextWindowFor('claude-opus-51m')).toBe(DEFAULT_CONTEXT_WINDOW);
    });

    it('模型未知时返回 null 而不是猜一个分母', () => {
        expect(contextWindowFor(null)).toBeNull();
        expect(contextWindowFor(undefined)).toBeNull();
        expect(contextWindowFor('')).toBeNull();
        expect(contextWindowFor('   ')).toBeNull();
        expect(contextWindowFor(123 as unknown as string)).toBeNull();
    });
});

describe('contextPercentOf', () => {
    it('按给定窗口算百分比', () => {
        expect(contextPercentOf(100_000, DEFAULT_CONTEXT_WINDOW)).toBe(50);
        expect(contextPercentOf(100_000, LONG_CONTEXT_WINDOW)).toBe(10);
    });

    it('这就是 B-135 的回归：同样的 190k 在 1M 模型上不该是 100%', () => {
        expect(contextPercentOf(190_000, LONG_CONTEXT_WINDOW)).toBe(19);
        expect(contextPercentOf(190_000, DEFAULT_CONTEXT_WINDOW)).toBe(95);
    });

    it('clamp 到 0..100', () => {
        expect(contextPercentOf(5_000_000, DEFAULT_CONTEXT_WINDOW)).toBe(100);
        expect(contextPercentOf(-5, DEFAULT_CONTEXT_WINDOW)).toBe(0);
        expect(contextPercentOf(0, DEFAULT_CONTEXT_WINDOW)).toBe(0);
    });

    it('窗口未知/非法时返回 null', () => {
        expect(contextPercentOf(1000, null)).toBeNull();
        expect(contextPercentOf(1000, 0)).toBeNull();
        expect(contextPercentOf(1000, -1)).toBeNull();
    });
});
