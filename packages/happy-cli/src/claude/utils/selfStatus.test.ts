/**
 * B-556 set_status: text normalization, write coalescing, and that the tool
 * reaches every managed runner without being forced through the system prompt.
 * Source assertions verified with scripts/dev/mutation-check.mjs.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { PI_TEAMS_EXTENSION } from '@/teams/resources';
import { AGENT_GUIDANCE } from './agentGuidance';
import {
    SELF_STATUS_DEDUPE_MS, SELF_STATUS_MAX_CHARS, SELF_STATUS_MIN_INTERVAL_MS, SELF_STATUS_TOOL_NAME,
    createSelfStatusExecutor, createSelfStatusPublisher, normalizeSelfStatusText, type SelfStatus,
} from './selfStatus';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/^\s*\/\/.*$/gm, '');

describe('normalizeSelfStatusText', () => {
    it('flattens to one trimmed line and caps at the limit with an ellipsis', () => {
        expect(normalizeSelfStatusText('  running\n  tests  ')).toBe('running tests');
        const long = normalizeSelfStatusText('字'.repeat(200))!;
        expect(Array.from(long)).toHaveLength(SELF_STATUS_MAX_CHARS);
        expect(long.endsWith('…')).toBe(true);
        expect(normalizeSelfStatusText('x'.repeat(SELF_STATUS_MAX_CHARS))).toBe('x'.repeat(SELF_STATUS_MAX_CHARS));
    });
    it('rejects empty and non-strings', () => {
        expect(normalizeSelfStatusText('   ')).toBeNull();
        expect(normalizeSelfStatusText(42)).toBeNull();
    });
});

function harness() {
    let clock = 1_000_000;
    const writes: SelfStatus[] = [];
    let scheduled: { fn: () => void; at: number } | null = null;
    const publisher = createSelfStatusPublisher({
        write: (s) => writes.push(s),
        now: () => clock,
        setTimer: (fn, ms) => { scheduled = { fn, at: clock + ms }; return 1; },
        clearTimer: () => { scheduled = null; },
    });
    const advance = (ms: number) => {
        clock += ms;
        if (scheduled && scheduled.at <= clock) { const { fn } = scheduled; scheduled = null; fn(); }
    };
    return { publisher, writes, advance, pending: () => scheduled !== null };
}

describe('createSelfStatusPublisher', () => {
    it('writes the first status immediately', () => {
        const h = harness();
        h.publisher.publish('planning the fix', 'planning');
        expect(h.writes).toEqual([{ text: 'planning the fix', phase: 'planning', updatedAt: 1_000_000 }]);
    });

    it('coalesces a burst into one trailing write of the NEWEST value (never drops it)', () => {
        const h = harness();
        h.publisher.publish('a');
        h.advance(1_000);
        h.publisher.publish('b', 'implementing');
        h.publisher.publish('c', 'testing');
        expect(h.writes.map((w) => w.text)).toEqual(['a']);
        h.advance(SELF_STATUS_MIN_INTERVAL_MS);
        expect(h.writes.map((w) => w.text)).toEqual(['a', 'c']);
        expect(h.writes[1].phase).toBe('testing');
    });

    it('skips an identical re-send inside the dedupe window, refreshes it after', () => {
        const h = harness();
        h.publisher.publish('same', 'testing');
        h.advance(SELF_STATUS_MIN_INTERVAL_MS + 1);
        h.publisher.publish('same', 'testing');
        expect(h.writes).toHaveLength(1);
        h.advance(SELF_STATUS_DEDUPE_MS);
        h.publisher.publish('same', 'testing');
        expect(h.writes).toHaveLength(2);
    });

    it('dispose drops a pending trailing write', () => {
        const h = harness();
        h.publisher.publish('a');
        h.publisher.publish('b');
        h.publisher.dispose();
        h.advance(SELF_STATUS_MIN_INTERVAL_MS);
        expect(h.writes.map((w) => w.text)).toEqual(['a']);
    });
});

describe('createSelfStatusExecutor', () => {
    it('normalizes, keeps known phases, ignores unknown ones', async () => {
        const publish = vi.fn();
        const execute = createSelfStatusExecutor({ publish });
        expect((await execute({ text: ' go ', phase: 'reviewing' })).isError).toBe(false);
        expect(publish).toHaveBeenLastCalledWith('go', 'reviewing');
        await execute({ text: 'x', phase: 'deploying' });
        expect(publish).toHaveBeenLastCalledWith('x', undefined);
    });
    it('reports an empty text as a tool error without writing', async () => {
        const publish = vi.fn();
        const result = await createSelfStatusExecutor({ publish })({ text: '  ' });
        expect(result.isError).toBe(true);
        expect(publish).not.toHaveBeenCalled();
    });
});

describe('set_status reaches every managed runner', () => {
    it('Claude: registered in-process, advertised in toolNames (SDK allowedTools), writes metadata.selfStatus', () => {
        const source = read('./startHappyServer.ts');
        expect(source).toContain('registerSelfStatusTool(mcp, handlers.setStatus);');
        expect(source).toContain('            SELF_STATUS_TOOL_NAME,\n');
        expect(source).toContain('write: (selfStatus) => client.updateMetadata((metadata) => ({ ...metadata, selfStatus })),');
        expect(source).toContain('selfStatusPublisher.dispose();');
    });
    it('Codex / Gemini / ACP: the stdio bridge forwards it by name; Codex auto-approves it', () => {
        expect(read('../../codex/happyMcpStdioBridge.ts')).toContain('registerSelfStatusTool(server, async (args) => (await ensureHttpClient()).callTool({ name: SELF_STATUS_TOOL_NAME, arguments: args }) as any);');
        const codex = read('../../codex/utils/permissionHandler.ts');
        expect(codex).toContain("'mcp__happy__set_status',");
    });
    it('pi: discovered over tools/list and exempt from the per-call confirmation', () => {
        expect(PI_TEAMS_EXTENSION).toContain("await rpc('tools/list', {})");
        expect(PI_TEAMS_EXTENSION).toContain("'report_progress','set_status'].includes(event.toolName)");
    });
    it('is never forced through the system prompt (B-493)', () => {
        expect(AGENT_GUIDANCE).not.toContain(SELF_STATUS_TOOL_NAME);
    });
});
