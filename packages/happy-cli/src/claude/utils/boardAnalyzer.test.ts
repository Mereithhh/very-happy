import { describe, it, expect } from 'vitest';
import {
    ANALYZE_MIN_INTERVAL_MS,
    HOURLY_LIMIT,
    HOURLY_WINDOW_MS,
    buildBoardPrompt,
    computeInputHash,
    extractFromClaudeMessage,
    parseBoardAnalysis,
    pruneRateWindow,
    shouldAnalyze,
    type BoardAnalysisInput,
} from './boardAnalyzer';
import type { RawJSONLines } from '@/claude/types';

const TASKS = new Set(['t1', 't2']);

function input(overrides: Partial<BoardAnalysisInput> = {}): BoardAnalysisInput {
    return {
        lastUserMessage: 'fix the login bug',
        assistantTail: 'I fixed the null check in auth.ts',
        todos: ['[x] find bug', '[ ] add test'],
        tasks: [{ id: 't1', title: 'Login bug' }, { id: 't2', title: 'Board V2' }],
        ...overrides,
    };
}

describe('parseBoardAnalysis', () => {
    it('accepts a strict JSON verdict', () => {
        const out = parseBoardAnalysis('{"taskId":"t1","attention":"review","progress":"修好了空指针"}', TASKS);
        expect(out).toEqual({ taskId: 't1', attention: 'review', progress: '修好了空指针' });
    });

    it('accepts null taskId', () => {
        const out = parseBoardAnalysis('{"taskId":null,"attention":"none","progress":"进行中"}', TASKS);
        expect(out).toEqual({ taskId: null, attention: 'none', progress: '进行中' });
    });

    it('nulls a hallucinated taskId not in the offered list', () => {
        const out = parseBoardAnalysis('{"taskId":"made-up","attention":"blocked","progress":"卡住了"}', TASKS);
        expect(out).toEqual({ taskId: null, attention: 'blocked', progress: '卡住了' });
    });

    it('unwraps markdown fences', () => {
        const raw = '```json\n{"taskId":"t2","attention":"none","progress":"看板开发中"}\n```';
        expect(parseBoardAnalysis(raw, TASKS)?.taskId).toBe('t2');
    });

    it('tolerates prose around a single JSON object', () => {
        const raw = 'Here is the analysis:\n{"taskId":null,"attention":"none","progress":"ok"}\nHope this helps!';
        expect(parseBoardAnalysis(raw, TASKS)?.progress).toBe('ok');
    });

    it('drops garbage, wrong enum values, arrays and missing fields', () => {
        expect(parseBoardAnalysis('', TASKS)).toBeNull();
        expect(parseBoardAnalysis('not json at all', TASKS)).toBeNull();
        expect(parseBoardAnalysis('{"attention":"urgent","progress":"x","taskId":null}', TASKS)).toBeNull();
        expect(parseBoardAnalysis('{"taskId":null,"attention":"none"}', TASKS)).toBeNull();
        expect(parseBoardAnalysis('{"taskId":null,"attention":"none","progress":42}', TASKS)).toBeNull();
        expect(parseBoardAnalysis('[]', TASKS)).toBeNull();
        expect(parseBoardAnalysis('{"taskId":null,"attention":"none","progress":"   "}', TASKS)).toBeNull();
    });

    it('clamps an over-long progress line', () => {
        const raw = JSON.stringify({ taskId: null, attention: 'none', progress: '长'.repeat(500) });
        expect(parseBoardAnalysis(raw, TASKS)!.progress.length).toBeLessThanOrEqual(200);
    });
});

describe('computeInputHash + shouldAnalyze (per-session throttle)', () => {
    it('first run always passes', () => {
        const hash = computeInputHash(input());
        expect(shouldAnalyze({ lastRunAt: 0, lastHash: null }, hash, Date.now())).toBe(true);
    });

    it('same hash never re-runs, even after the interval', () => {
        const hash = computeInputHash(input());
        const state = { lastRunAt: 1000, lastHash: hash };
        expect(shouldAnalyze(state, hash, 1000 + ANALYZE_MIN_INTERVAL_MS * 10)).toBe(false);
    });

    it('changed hash within the 5-min interval is still throttled', () => {
        const h1 = computeInputHash(input());
        const h2 = computeInputHash(input({ assistantTail: 'something new happened' }));
        expect(h1).not.toBe(h2);
        const state = { lastRunAt: 1000, lastHash: h1 };
        expect(shouldAnalyze(state, h2, 1000 + ANALYZE_MIN_INTERVAL_MS - 1)).toBe(false);
    });

    it('changed hash after the interval runs', () => {
        const h1 = computeInputHash(input());
        const h2 = computeInputHash(input({ todos: ['[x] all done'] }));
        const state = { lastRunAt: 1000, lastHash: h1 };
        expect(shouldAnalyze(state, h2, 1000 + ANALYZE_MIN_INTERVAL_MS + 1)).toBe(true);
    });

    it('a new task appearing changes the hash (re-classification is legitimate)', () => {
        const h1 = computeInputHash(input());
        const h2 = computeInputHash(input({ tasks: [...input().tasks, { id: 't3', title: 'New task' }] }));
        expect(h1).not.toBe(h2);
    });
});

describe('pruneRateWindow (machine hourly cap)', () => {
    it('allows while under the cap and prunes old entries', () => {
        const now = 10 * HOURLY_WINDOW_MS;
        const old = now - HOURLY_WINDOW_MS - 1;
        const { window, allowed } = pruneRateWindow([old, now - 1000], now);
        expect(allowed).toBe(true);
        expect(window).toEqual([now - 1000]);
    });

    it('denies at the cap', () => {
        const now = 10 * HOURLY_WINDOW_MS;
        const stamps = Array.from({ length: HOURLY_LIMIT }, (_, i) => now - i * 1000 - 1);
        expect(pruneRateWindow(stamps, now).allowed).toBe(false);
    });

    it('re-allows once entries age out of the window', () => {
        const now = 10 * HOURLY_WINDOW_MS;
        const stamps = Array.from({ length: HOURLY_LIMIT }, (_, i) => now - i * 1000 - 1);
        expect(pruneRateWindow(stamps, now + HOURLY_WINDOW_MS + 2000).allowed).toBe(true);
    });

    it('ignores garbage and future timestamps', () => {
        const now = 1_000_000;
        const { window } = pruneRateWindow([NaN as unknown as number, now + 999999, now - 1], now);
        expect(window).toEqual([now - 1]);
    });
});

describe('buildBoardPrompt', () => {
    it('includes tasks, user message, assistant tail and todos', () => {
        const p = buildBoardPrompt(input());
        expect(p).toContain('- t1: Login bug');
        expect(p).toContain('fix the login bug');
        expect(p).toContain('null check in auth.ts');
        expect(p).toContain('[ ] add test');
    });

    it('degrades to "(no tasks defined)" without a task list', () => {
        const p = buildBoardPrompt(input({ tasks: [] }));
        expect(p).toContain('(no tasks defined)');
    });
});

describe('extractFromClaudeMessage', () => {
    it('pulls the last text block and TodoWrite todos from an assistant line', () => {
        const body = {
            type: 'assistant',
            uuid: 'u1',
            message: {
                content: [
                    { type: 'text', text: 'working on it' },
                    {
                        type: 'tool_use', name: 'TodoWrite', input: {
                            todos: [
                                { content: 'find bug', status: 'completed' },
                                { content: 'fix bug', status: 'in_progress' },
                                { content: 'test', status: 'pending' },
                            ]
                        }
                    },
                ],
            },
        } as unknown as RawJSONLines;
        const out = extractFromClaudeMessage(body);
        expect(out.assistantText).toBe('working on it');
        expect(out.todos).toEqual(['[x] find bug', '[~] fix bug', '[ ] test']);
    });

    it('ignores user/system lines and assistant lines without array content', () => {
        expect(extractFromClaudeMessage({ type: 'system', uuid: 'x' } as unknown as RawJSONLines)).toEqual({});
        expect(extractFromClaudeMessage({
            type: 'assistant', uuid: 'y', message: { content: 'plain string' },
        } as unknown as RawJSONLines)).toEqual({});
    });
});
