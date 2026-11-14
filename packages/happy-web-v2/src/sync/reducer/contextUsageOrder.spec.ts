/**
 * B-937 回归：输入框「已用 0% 上下文 · 0 / 1.0M tokens」。
 *
 * 历史是倒着补的：先到最新页，再按 before_seq 往前补旧页（older-page 增量喂进
 * 同一个 reducer state；messageOrder 只在同一批内按 seq 排序）。旧页里的
 * `Compaction completed` / `Context was reset` 事件因此会在最新用量之后才被处理。
 * 修复前它们不比较先后、无条件把 latestUsage 清零，于是长会话（压缩过多次）一往
 * 上翻就显示 0%，直到下一条 assistant 消息到来。
 */
import { describe, expect, it } from 'vitest';
import type { NormalizedMessage } from '../typesRaw';
import { createReducer, reducer } from './reducer';

const MODEL = 'claude-opus-5[1m]';

function assistant(id: string, seq: number, createdAt: number, contextTokens: number, extra: Partial<NormalizedMessage> = {}): NormalizedMessage {
    return {
        id, localId: null, createdAt, seq, role: 'agent', isSidechain: false,
        content: [{ type: 'text', text: `reply ${id}`, uuid: `u-${id}`, parentUUID: null }],
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: contextTokens - 10 },
        model: MODEL,
        ...extra,
    } as NormalizedMessage;
}

function event(id: string, seq: number, createdAt: number, message: 'Compaction completed' | 'Context was reset'): NormalizedMessage {
    return { id, localId: null, createdAt, seq, role: 'event', isSidechain: false, content: { type: 'message', message } };
}

describe('B-937：上下文用量不被更早的事件或消息覆盖', () => {
    for (const kind of ['Compaction completed', 'Context was reset'] as const) {
        it(`乱序批次：新页先到，旧页里的「${kind}」后到，不把最新用量清零`, () => {
            const state = createReducer();
            // 最新页：压缩之后的对话，最新用量 100k
            reducer(state, [assistant('a3', 30, 3000, 80_000), assistant('a4', 40, 4000, 100_000)]);
            expect(state.latestUsage?.contextSize).toBe(100_000);
            // 旧页：更早的一次压缩，以及压缩前的大用量
            const result = reducer(state, [assistant('a1', 10, 1000, 900_000), event('c1', 20, 2000, kind)]);
            expect(result.usage?.contextSize).toBe(100_000);
            expect(state.latestUsage?.contextSize).toBe(100_000);
            expect(state.latestUsage?.model).toBe(MODEL);
        });

        it(`乱序批次：「${kind}」之前的旧用量在其后到达，不回退显示`, () => {
            const state = createReducer();
            // 最新页里只有压缩事件（压缩后还没有新的回复）
            reducer(state, [assistant('a0', 5, 500, 50_000), event('c1', 20, 2000, kind)]);
            expect(state.latestUsage?.contextSize).toBe(0);
            // 旧页带回压缩前、但比 a0 新的用量——它早于压缩，不能顶上来
            reducer(state, [assistant('a1', 10, 1000, 900_000)]);
            expect(state.latestUsage?.contextSize).toBe(0);
        });

        it(`正常顺序：「${kind}」发生在最新用量之后仍归零，保留 model（B-135）`, () => {
            const state = createReducer();
            reducer(state, [assistant('a1', 10, 1000, 900_000)]);
            const result = reducer(state, [event('c1', 20, 2000, kind)]);
            expect(result.usage).toMatchObject({ contextSize: 0, model: MODEL });
        });

        it(`「${kind}」后下一条 assistant 恢复用量`, () => {
            const state = createReducer();
            reducer(state, [assistant('a1', 10, 1000, 900_000), event('c1', 20, 2000, kind)]);
            const result = reducer(state, [assistant('a2', 30, 3000, 40_000)]);
            expect(result.usage?.contextSize).toBe(40_000);
        });
    }

    it('同毫秒时按 seq 判先后：压缩在用量之后（seq 更大）仍归零', () => {
        const state = createReducer();
        reducer(state, [assistant('a1', 10, 1000, 900_000)]);
        reducer(state, [event('c1', 11, 1000, 'Compaction completed')]);
        expect(state.latestUsage?.contextSize).toBe(0);
    });

    it('从未有过用量的会话（如 Codex：消息不带 usage）压缩后不伪造 0%，仍显示未知', () => {
        const state = createReducer();
        const result = reducer(state, [event('c1', 20, 2000, 'Compaction completed')]);
        expect(result.usage).toBeUndefined();
        expect(state.latestUsage).toBeUndefined();
        // 压缩前的用量随后到达：不能顶上来；它说明这个 agent 会报用量，压缩后的上下文为 0
        reducer(state, [assistant('a1', 10, 1000, 900_000)]);
        expect(state.latestUsage).toMatchObject({ contextSize: 0, model: MODEL });
    });

    it('同一批里正常顺序（用量 → 压缩）：归零（事件在本批回复之前处理，也不能变成未知）', () => {
        const state = createReducer();
        const result = reducer(state, [assistant('a1', 10, 1000, 900_000), event('c1', 20, 2000, 'Compaction completed')]);
        expect(result.usage).toMatchObject({ contextSize: 0, model: MODEL });
    });

    it('子 agent（sidechain）消息的 usage 不覆盖主会话上下文用量', () => {
        const state = createReducer();
        reducer(state, [assistant('a1', 10, 1000, 120_000)]);
        // 父工具调用不在已加载窗口内时，session 协议的子 agent 消息（subagent id 非 uuid）
        // 会被 tracer 当成独立消息放行到主链处理
        const child = assistant('s1', 20, 2000, 8_000, {
            isSidechain: true,
            content: [{ type: 'text', text: 'child', uuid: 'u-s1', parentUUID: 'ckabcdefghijklmnop' }],
        } as Partial<NormalizedMessage>);
        reducer(state, [child]);
        expect(state.latestUsage?.contextSize).toBe(120_000);
    });

    it('Context was reset：旧页里的重置不清掉更新的 todos', () => {
        const state = createReducer();
        state.latestTodos = { todos: [{ content: 'x', status: 'pending', priority: 'medium', id: '1' }] as never, timestamp: 4000 };
        reducer(state, [event('r1', 20, 2000, 'Context was reset')]);
        expect(state.latestTodos?.todos).toHaveLength(1);
    });
});
