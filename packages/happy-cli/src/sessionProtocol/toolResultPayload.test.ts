import { describe, expect, it } from 'vitest';
import { mapClaudeLogMessageToSessionEnvelopes, type ClaudeSessionProtocolState } from '@/claude/utils/sessionProtocolMapper';
import { capUtf8, TOOL_RESULT_MAX_BYTES, toolResultContentText, toolResultPayload } from './toolResultPayload';

/** tool_use → tool_result through the real mapper; returns the tool-call-end event. */
function endFor(name: string, input: Record<string, unknown>, result: { content: unknown; is_error?: boolean }) {
    const state: ClaudeSessionProtocolState = { currentTurnId: null };
    mapClaudeLogMessageToSessionEnvelopes({
        type: 'assistant',
        uuid: 'a-1',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name, input }] },
    } as any, state);
    const ended = mapClaudeLogMessageToSessionEnvelopes({
        type: 'user',
        uuid: 'u-1',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', ...result }] },
    } as any, state);
    const end = ended.envelopes.find((e) => e.ev.t === 'tool-call-end');
    expect(end).toBeDefined();
    return end!.ev as { t: 'tool-call-end'; call: string; result?: { text: string; truncated?: boolean; isError?: boolean } };
}

describe('tool-call-end carries the tool output (B-771)', () => {
    it('Bash: stdout', () => {
        const ev = endFor('Bash', { command: 'ls' }, { content: 'a.txt\nb.txt' });
        expect(ev).toEqual({ t: 'tool-call-end', call: 'toolu_1', result: { text: 'a.txt\nb.txt' } });
    });

    it('Bash is_error: marked isError so the card turns red', () => {
        const ev = endFor('Bash', { command: 'false' }, { content: 'Exit code 1', is_error: true });
        expect(ev.result).toEqual({ text: 'Exit code 1', isError: true });
    });

    it('Read: cat -n file content', () => {
        const content = '     1\timport x\n     2\texport y\n';
        const ev = endFor('Read', { file_path: '/r/a.ts' }, { content });
        expect(ev.result).toEqual({ text: content });
    });

    it('Edit: the confirmation line', () => {
        const ev = endFor('Edit', { file_path: '/r/a.ts', old_string: 'a', new_string: 'b' }, { content: 'The file /r/a.ts has been updated.' });
        expect(ev.result?.text).toBe('The file /r/a.ts has been updated.');
    });

    it('WebSearch: the result text with its Links list', () => {
        const content = 'Web search results for query: "vh"\n\nLinks: [{"title":"VH","url":"https://veryhappy.dev"}]';
        const ev = endFor('WebSearch', { query: 'vh' }, { content });
        expect(ev.result?.text).toBe(content);
    });

    it('MCP: content-block array joins text blocks; an image only names its type and size', () => {
        const ev = endFor('mcp__jina__primer', {}, {
            content: [
                { type: 'text', text: '{"time":"2026-10-23"}' },
                { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(4096) } },
            ],
        });
        expect(ev.result).toEqual({ text: '{"time":"2026-10-23"}\n[image image/png, 3 KB]' });
        expect(ev.result!.text).not.toContain('AAAA');
    });

    it('an empty successful result carries no result (Web shows the empty state)', () => {
        const ev = endFor('Bash', { command: 'true' }, { content: '' });
        expect(ev).toEqual({ t: 'tool-call-end', call: 'toolu_1' });
    });

    it('an empty failed result still carries isError', () => {
        expect(endFor('Bash', { command: 'x' }, { content: [], is_error: true }).result).toEqual({ text: '', isError: true });
    });

    it('oversized output is capped and marked truncated', () => {
        const ev = endFor('Bash', { command: 'yes' }, { content: 'y\n'.repeat(100_000) });
        expect(ev.result?.truncated).toBe(true);
        expect(Buffer.byteLength(ev.result!.text, 'utf8')).toBeLessThanOrEqual(TOOL_RESULT_MAX_BYTES);
        expect(Buffer.byteLength(ev.result!.text, 'utf8')).toBeGreaterThan(TOOL_RESULT_MAX_BYTES - 4);
    });
});

describe('capUtf8', () => {
    it('keeps short text untouched', () => {
        expect(capUtf8('hello', 10)).toEqual({ text: 'hello', truncated: false });
        expect(capUtf8('中文', 6)).toEqual({ text: '中文', truncated: false });
    });

    it('counts UTF-8 bytes, not UTF-16 units, and cuts between CJK characters', () => {
        // 中 = 3 bytes; 7 bytes fit two characters, never a partial third.
        expect(capUtf8('中文字符', 7)).toEqual({ text: '中文', truncated: true });
        expect(capUtf8('a'.repeat(20), 8)).toEqual({ text: 'a'.repeat(8), truncated: true });
    });

    it('never splits a surrogate pair (emoji)', () => {
        // 😀 = 4 bytes / 2 UTF-16 units; 'a😀😀' is 9 bytes.
        const out = capUtf8('a😀😀', 8);
        expect(out).toEqual({ text: 'a😀', truncated: true });
        expect(out.text).not.toMatch(/[\uD800-\uDBFF]$/);
        const cut = capUtf8('😀'.repeat(10), 7);
        expect(cut.text).toBe('😀');
    });

    it('fits exactly at the limit without marking truncated', () => {
        expect(capUtf8('中文', 6)).toEqual({ text: '中文', truncated: false });
        expect(capUtf8('a😀', 5)).toEqual({ text: 'a😀', truncated: false });
    });
});

describe('toolResultContentText / toolResultPayload', () => {
    it('labels unknown and document blocks without their bytes', () => {
        expect(toolResultContentText([
            { type: 'document', source: { media_type: 'application/pdf', data: 'QUJD' } },
            { type: 'tool_reference', tool_name: 'x' },
        ])).toBe('[document application/pdf, 1 KB]\n[tool_reference]');
    });

    it('returns undefined for non-content', () => {
        expect(toolResultPayload({ content: undefined })).toBeUndefined();
        expect(toolResultPayload({ content: 42 })).toBeUndefined();
    });

    it('large CJK output: capped by bytes, truncated, whole characters', () => {
        const out = toolResultPayload({ content: '汉字'.repeat(20_000) })!;
        expect(out.truncated).toBe(true);
        expect(Buffer.byteLength(out.text, 'utf8')).toBe(Math.floor(TOOL_RESULT_MAX_BYTES / 3) * 3);
        expect([...out.text].every((ch) => ch === '汉' || ch === '字')).toBe(true);
    });
});
