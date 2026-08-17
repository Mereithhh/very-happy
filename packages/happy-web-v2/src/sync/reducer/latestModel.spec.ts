/**
 * B-135 链路回归：assistant 消息里的**真实模型 id** 必须一路走到 reducer 结果。
 *
 * 为什么单独一条：`contextWindow.test.ts` 只测了纯函数（给定模型 → 给定分母），
 * 证明不了「模型真的到得了 UI」。而这条链路有四个可以静默断开的接头——
 * schema 解析、归一化时的对象字面量、reducer 的 processUsageData、结果导出。
 * 断掉的表现不是报错，是**百分比默默用错分母**，正是 B-135 本来的症状。
 */
import { describe, expect, it } from 'vitest';
import { RawRecordSchema, normalizeRawMessage } from '../typesRaw';
import { createReducer, reducer } from './reducer';
import { contextPercentOf, contextWindowFor } from '../../screens/session/contextWindow';

function assistantRecord(model: string, usage: { input: number; cacheRead?: number; cacheCreation?: number }) {
    return RawRecordSchema.parse({
        role: 'agent',
        content: {
            type: 'output',
            data: {
                type: 'assistant',
                message: {
                    role: 'assistant',
                    model,
                    content: [{ type: 'text', text: 'ok' }],
                    usage: {
                        input_tokens: usage.input,
                        output_tokens: 12,
                        cache_read_input_tokens: usage.cacheRead ?? 0,
                        cache_creation_input_tokens: usage.cacheCreation ?? 0,
                    },
                },
                uuid: `u-${model}-${usage.input}`,
                parentUuid: null,
            },
        },
    });
}

function runChain(model: string, usage: { input: number; cacheRead?: number; cacheCreation?: number }) {
    const normalized = normalizeRawMessage('m1', null, 1000, assistantRecord(model, usage));
    expect(normalized, 'normalizeRawMessage 不应返回 null').not.toBeNull();
    const state = createReducer();
    return reducer(state, [normalized!]);
}

describe('B-135：真实模型 id 贯穿 raw → normalize → reducer', () => {
    it('归一化保留 message.model（schema 一直解析着，早先被丢在这一步）', () => {
        const normalized = normalizeRawMessage('m1', null, 1000, assistantRecord('claude-opus-5[1m]', { input: 100 }));
        expect(normalized).not.toBeNull();
        expect((normalized as { model?: string }).model).toBe('claude-opus-5[1m]');
    });

    it('reducer 结果带出 model，且 contextSize 仍是 input+cache（不含 output）', () => {
        const result = runChain('claude-opus-5[1m]', { input: 100, cacheRead: 50, cacheCreation: 25 });
        expect(result.usage?.model).toBe('claude-opus-5[1m]');
        expect(result.usage?.contextSize).toBe(175);
    });

    it('端到端：同样的 190k 在 1M 模型上是 19%，在 200k 模型上是 95%', () => {
        const long = runChain('claude-opus-5[1m]', { input: 190_000 });
        const std = runChain('claude-sonnet-4-6', { input: 190_000 });
        expect(contextPercentOf(long.usage!.contextSize, contextWindowFor(long.usage!.model))).toBe(19);
        expect(contextPercentOf(std.usage!.contextSize, contextWindowFor(std.usage!.model))).toBe(95);
    });

    it('模型未知时不产出百分比（宁可只显示 token 数，不显示错的百分比）', () => {
        expect(contextPercentOf(190_000, contextWindowFor(undefined))).toBeNull();
    });
});
