/**
 * toolInfo pure-function tests — the copy affordances (tool output copy,
 * command copy) rely on these returning the FULL raw text for every result
 * shape, so lock the shapes down.
 */
import { describe, expect, it } from 'vitest';
import type { ToolCall } from '@/sync/typesMessage';
import { asCommand, commandOutputText, extractError, resultToText } from './toolInfo';

describe('resultToText', () => {
    it('returns empty string for null/undefined', () => {
        expect(resultToText(null)).toBe('');
        expect(resultToText(undefined)).toBe('');
    });

    it('passes plain strings through untouched (no truncation)', () => {
        const long = 'x'.repeat(500_000);
        expect(resultToText(long)).toBe(long);
        expect(resultToText('hello\nworld')).toBe('hello\nworld');
    });

    it('joins stdout + stderr envelopes', () => {
        expect(resultToText({ stdout: 'out', stderr: 'err' })).toBe('out\nerr');
        expect(resultToText({ stdout: 'only out' })).toBe('only out');
        expect(resultToText({ stderr: 'only err' })).toBe('only err');
    });

    it('joins MCP-style content-block arrays', () => {
        expect(
            resultToText([
                { type: 'text', text: 'first' },
                { type: 'image', data: 'zzz' },
                { type: 'text', text: 'second' },
            ]),
        ).toBe('first\nsecond');
    });

    it('falls back to pretty JSON for arrays without text blocks', () => {
        expect(resultToText([{ a: 1 }])).toBe(JSON.stringify([{ a: 1 }], null, 2));
    });

    it('unwraps nested content envelopes', () => {
        expect(resultToText({ content: [{ type: 'text', text: 'inner' }] })).toBe('inner');
        expect(resultToText({ content: 'plain inner' })).toBe('plain inner');
    });

    it('reads text/output/result string fields', () => {
        expect(resultToText({ text: 't' })).toBe('t');
        expect(resultToText({ output: 'o' })).toBe('o');
        expect(resultToText({ result: 'r' })).toBe('r');
    });

    it('falls back to pretty JSON for unrecognized objects', () => {
        expect(resultToText({ foo: 42 })).toBe(JSON.stringify({ foo: 42 }, null, 2));
    });
});

describe('commandOutputText', () => {
    it('joins stdout, stderr and error in render order', () => {
        expect(commandOutputText({ stdout: 'out', stderr: 'err', error: 'boom' })).toBe('out\nerr\nboom');
    });

    it('skips missing and whitespace-only streams', () => {
        expect(commandOutputText({ stdout: 'out' })).toBe('out');
        expect(commandOutputText({ stdout: '   \n', stderr: 'err' })).toBe('err');
        expect(commandOutputText({ stdout: null, stderr: undefined, error: null })).toBe('');
        expect(commandOutputText({})).toBe('');
    });

    it('keeps full multi-line stream content untouched', () => {
        const stdout = 'line1\nline2\n\nline4';
        expect(commandOutputText({ stdout })).toBe(stdout);
    });
});

describe('asCommand', () => {
    const bash = (over: Partial<ToolCall>): ToolCall =>
        ({ name: 'Bash', state: 'completed', input: { command: 'ls -la' }, ...over }) as ToolCall;

    it('returns null for non-Bash tools and missing commands', () => {
        expect(asCommand({ name: 'Read', state: 'completed', input: {} } as ToolCall)).toBeNull();
        expect(asCommand(bash({ input: {} }))).toBeNull();
    });

    it('extracts stdout/stderr from object results', () => {
        const cmd = asCommand(bash({ result: { stdout: 'out', stderr: 'err' } }));
        expect(cmd).toEqual({ command: 'ls -la', stdout: 'out', stderr: 'err', error: undefined });
    });

    it('treats a plain string result as stdout', () => {
        const cmd = asCommand(bash({ result: 'raw output' }));
        expect(cmd?.stdout).toBe('raw output');
        expect(cmd?.stderr).toBeUndefined();
    });
});

describe('extractError', () => {
    it('reads string results and error/message fields', () => {
        expect(extractError({ name: 'X', state: 'error', result: 'bad' } as ToolCall)).toBe('bad');
        expect(extractError({ name: 'X', state: 'error', result: { error: 'e' } } as ToolCall)).toBe('e');
        expect(extractError({ name: 'X', state: 'error', result: { message: 'm' } } as ToolCall)).toBe('m');
        expect(extractError({ name: 'X', state: 'error', result: {} } as ToolCall)).toBeUndefined();
    });
});
