import { describe, expect, it } from 'vitest';
import {
    normalizeToolName,
    toolFriendlyKey,
    toolParamSummary,
    TOOL_SUMMARY_MAX_CHARS,
    SESSION_ID_SUMMARY_CHARS,
} from './toolDisplay';

describe('normalizeToolName', () => {
    it('strips the mcp__server__ prefix', () => {
        expect(normalizeToolName('mcp__happy__session_spawn')).toBe('session_spawn');
        expect(normalizeToolName('mcp__some-server__terminal_read')).toBe('terminal_read');
    });

    it('passes plain names through', () => {
        expect(normalizeToolName('Bash')).toBe('Bash');
        expect(normalizeToolName('session_send')).toBe('session_send');
    });

    it('leaves malformed mcp names untouched', () => {
        expect(normalizeToolName('mcp__nounderscore')).toBe('mcp__nounderscore');
        expect(normalizeToolName('mcp__server__')).toBe('mcp__server__');
    });
});

describe('toolFriendlyKey', () => {
    it('maps the assistant tool face (with and without mcp prefix)', () => {
        expect(toolFriendlyKey('sessions_list')).toBe('sessionsList');
        expect(toolFriendlyKey('mcp__happy__sessions_list')).toBe('sessionsList');
        expect(toolFriendlyKey('session_spawn')).toBe('sessionSpawn');
        expect(toolFriendlyKey('session_send')).toBe('sessionSend');
        expect(toolFriendlyKey('session_read')).toBe('sessionRead');
        expect(toolFriendlyKey('terminals_list')).toBe('terminalsList');
        expect(toolFriendlyKey('terminal_read')).toBe('terminalRead');
        expect(toolFriendlyKey('terminal_send')).toBe('terminalSend');
        expect(toolFriendlyKey('memory_update')).toBe('memoryUpdate');
        expect(toolFriendlyKey('journal_append')).toBe('journalAppend');
    });

    it('maps builtin lookup and web tools', () => {
        expect(toolFriendlyKey('Read')).toBe('lookup');
        expect(toolFriendlyKey('Grep')).toBe('lookup');
        expect(toolFriendlyKey('Glob')).toBe('lookup');
        expect(toolFriendlyKey('WebSearch')).toBe('web');
        expect(toolFriendlyKey('WebFetch')).toBe('web');
    });

    it('falls back to null for everything else', () => {
        expect(toolFriendlyKey('Bash')).toBeNull();
        expect(toolFriendlyKey('session_kill')).toBeNull();
        expect(toolFriendlyKey('mcp__other__unknown_tool')).toBeNull();
    });
});

describe('toolParamSummary', () => {
    it('session_spawn shows the target directory basename', () => {
        expect(toolParamSummary('session_spawn', { directory: '/Users/demo/code/github/very-happy' })).toBe(
            'very-happy',
        );
        expect(toolParamSummary('mcp__happy__session_spawn', { directory: '/tmp/x/' })).toBe('x');
    });

    it('session_send resolves the target session title through the context', () => {
        const resolveSessionTitle = (id: string) => (id === 'abcdef1234567890' ? '发布 web-v2' : null);
        expect(
            toolParamSummary('session_send', { sessionId: 'abcdef1234567890', text: 'hi' }, { resolveSessionTitle }),
        ).toBe('发布 web-v2');
    });

    it('session_send/session_read fall back to the id prefix without a title', () => {
        expect(toolParamSummary('session_send', { sessionId: 'abcdef1234567890' })).toBe(
            'abcdef1234567890'.slice(0, SESSION_ID_SUMMARY_CHARS),
        );
        expect(
            toolParamSummary('session_read', { sessionId: 'abcdef1234567890' }, { resolveSessionTitle: () => '   ' }),
        ).toBe('abcdef12');
    });

    it('list tools have no summary', () => {
        expect(toolParamSummary('sessions_list', {})).toBeNull();
        expect(toolParamSummary('terminals_list', { anything: 'x' })).toBeNull();
    });

    it('terminal tools show the terminal id', () => {
        expect(toolParamSummary('terminal_read', { terminalId: 'vh-12345' })).toBe('vh-12345');
        expect(toolParamSummary('terminal_send', { terminalId: 'vh-12345', text: 'ls' })).toBe('vh-12345');
    });

    it('memory_update shows the section, journal_append the note', () => {
        expect(toolParamSummary('memory_update', { section: '偏好', content: '…' })).toBe('偏好');
        expect(toolParamSummary('journal_append', { text: '今天修好了 earcon' })).toBe('今天修好了 earcon');
    });

    it('Read shows the file basename, Grep/Glob the pattern', () => {
        expect(toolParamSummary('Read', { file_path: '/a/b/notes.md' })).toBe('notes.md');
        expect(toolParamSummary('Grep', { pattern: 'foo.*bar' })).toBe('foo.*bar');
        expect(toolParamSummary('Glob', { pattern: '**/*.ts' })).toBe('**/*.ts');
    });

    it('WebSearch shows the query, WebFetch the hostname', () => {
        expect(toolParamSummary('WebSearch', { query: 'vitest mock timers' })).toBe('vitest mock timers');
        expect(toolParamSummary('WebFetch', { url: 'https://example.com/a/very/long/path' })).toBe('example.com');
        expect(toolParamSummary('WebFetch', { url: 'not a url' })).toBe('not a url');
    });

    it('Bash shows the command; unknown tools use generic fields', () => {
        expect(toolParamSummary('Bash', { command: 'git status' })).toBe('git status');
        expect(toolParamSummary('some_tool', { query: 'q' })).toBe('q');
        expect(toolParamSummary('some_tool', { prompt: 'p' })).toBe('p');
        expect(toolParamSummary('some_tool', { unrelated: 1 })).toBeNull();
    });

    it('is defensive about malformed input', () => {
        expect(toolParamSummary('session_spawn', null)).toBeNull();
        expect(toolParamSummary('session_spawn', undefined)).toBeNull();
        expect(toolParamSummary('session_spawn', 'string')).toBeNull();
        expect(toolParamSummary('session_spawn', [1, 2])).toBeNull();
        expect(toolParamSummary('session_spawn', { directory: 42 })).toBeNull();
        expect(toolParamSummary('session_send', { sessionId: '' })).toBeNull();
    });

    it('truncates long summaries with an ellipsis', () => {
        const long = 'x'.repeat(200);
        const out = toolParamSummary('Bash', { command: long });
        expect(out).toHaveLength(TOOL_SUMMARY_MAX_CHARS);
        expect(out!.endsWith('…')).toBe(true);
    });

    it('never lets a throwing resolver escape', () => {
        expect(
            toolParamSummary(
                'session_send',
                { sessionId: 'abcdef1234567890' },
                {
                    resolveSessionTitle: () => {
                        throw new Error('boom');
                    },
                },
            ),
        ).toBeNull();
    });
});
