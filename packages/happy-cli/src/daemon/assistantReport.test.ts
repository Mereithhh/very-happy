import { describe, expect, it } from 'vitest';
import {
    ASSISTANT_REPORT_COOLDOWN_MS,
    decideAssistantReport,
    formatAssistantReportMessage,
    resolveReportSessionTitle,
} from './assistantReport';
import type { Metadata } from '@/api/types';

const NOW = 1_000_000_000;

const base = {
    spawnedBy: 'assistant' as string | undefined,
    isAssistantSession: false,
    sessionId: 'worker-1',
    assistantSessionId: 'assistant-1' as string | undefined,
    lastReportAt: undefined as number | undefined,
    now: NOW,
};

describe('decideAssistantReport', () => {
    it('sends for an assistant-spawned session with a live assistant and no cooldown', () => {
        const d = decideAssistantReport({ ...base });
        expect(d).toEqual({ send: true, assistantSessionId: 'assistant-1' });
    });

    it('skips sessions not spawned by the assistant (undefined = old daemon/CLI)', () => {
        expect(decideAssistantReport({ ...base, spawnedBy: undefined }).send).toBe(false);
        expect(decideAssistantReport({ ...base, spawnedBy: 'user' }).send).toBe(false);
    });

    it('never reports the assistant about itself (variant tag)', () => {
        const d = decideAssistantReport({ ...base, isAssistantSession: true });
        expect(d.send).toBe(false);
    });

    it('never reports the assistant about itself (same session id)', () => {
        const d = decideAssistantReport({ ...base, sessionId: 'assistant-1' });
        expect(d.send).toBe(false);
    });

    it('skips silently when no live assistant exists', () => {
        const d = decideAssistantReport({ ...base, assistantSessionId: undefined });
        expect(d.send).toBe(false);
    });

    it('applies the per-session cooldown', () => {
        const justSent = decideAssistantReport({ ...base, lastReportAt: NOW - 1000 });
        expect(justSent.send).toBe(false);

        const almostElapsed = decideAssistantReport({
            ...base,
            lastReportAt: NOW - ASSISTANT_REPORT_COOLDOWN_MS + 1,
        });
        expect(almostElapsed.send).toBe(false);

        const elapsed = decideAssistantReport({
            ...base,
            lastReportAt: NOW - ASSISTANT_REPORT_COOLDOWN_MS,
        });
        expect(elapsed.send).toBe(true);
    });

    it('honors a custom cooldown', () => {
        const d = decideAssistantReport({ ...base, lastReportAt: NOW - 500, cooldownMs: 400 });
        expect(d.send).toBe(true);
    });

    it('cooldown is keyed per session by the caller (a fresh session id has no lastReportAt)', () => {
        // Simulates the run.ts map: worker-1 reported recently, worker-2 never did.
        const lastSentAt = new Map<string, number>([['worker-1', NOW - 1000]]);
        const d1 = decideAssistantReport({ ...base, lastReportAt: lastSentAt.get('worker-1') });
        const d2 = decideAssistantReport({ ...base, sessionId: 'worker-2', lastReportAt: lastSentAt.get('worker-2') });
        expect(d1.send).toBe(false);
        expect(d2.send).toBe(true);
    });
});

describe('resolveReportSessionTitle', () => {
    const meta = (m: Partial<Metadata>): Metadata => m as Metadata;

    it('prefers the generated summary', () => {
        expect(resolveReportSessionTitle(meta({
            summary: { text: '修复登录 bug', updatedAt: 1 },
            name: 'my-name',
            path: '/Users/x/proj',
        }), 's-1')).toBe('修复登录 bug');
    });

    it('falls back to name, then last path segment, then session id', () => {
        expect(resolveReportSessionTitle(meta({ name: 'my-name', path: '/Users/x/proj' }), 's-1')).toBe('my-name');
        expect(resolveReportSessionTitle(meta({ path: '/Users/x/proj' }), 's-1')).toBe('proj');
        expect(resolveReportSessionTitle(meta({}), 's-1')).toBe('s-1');
        expect(resolveReportSessionTitle(undefined, 's-1')).toBe('s-1');
    });

    it('ignores empty/whitespace summary and name', () => {
        expect(resolveReportSessionTitle(meta({
            summary: { text: '  ', updatedAt: 1 },
            name: '',
            path: '/a/b',
        }), 's-1')).toBe('b');
    });
});

describe('formatAssistantReportMessage', () => {
    it('renders the completed report', () => {
        expect(formatAssistantReportMessage('修复登录 bug', 'abc-123', 'completed')).toBe(
            '[系统通报] 会话「修复登录 bug」已完成（abc-123）。请用 session_read 核实结果，并向用户口头汇报一句结论；多条通报接近时合并汇报。',
        );
    });

    it('renders the needs_input report', () => {
        expect(formatAssistantReportMessage('调研任务', 'def-456', 'needs_input')).toBe(
            '[系统通报] 会话「调研任务」等待输入（def-456）。请用 session_read 核实结果，并向用户口头汇报一句结论；多条通报接近时合并汇报。',
        );
    });
});
