import { describe, expect, it, vi } from 'vitest';
vi.mock('@/text', async () => await import('@/testing/englishText'));

import type { ToolCall } from '@/sync/typesMessage';
import {
    acpResultText, commandInfo, fetchUrl, parseFetchedPage, parseSearchLinks, patchEdits, readInfo, searchQuery,
    stripReadLineNumbers, toolCardKind, toolHeader,
} from './toolPresentation';
import { TOOL_FIXTURES } from '@/dev/toolCardFixtures';

/**
 * B-754: the same operation arrives under each runner's own name/envelope;
 * these readers give every shape one card. Shapes are the CLI mappers' real
 * output (see toolCardFixtures.ts) — the data itself is never rewritten.
 */
const call = (name: string, input: unknown, extra: Partial<ToolCall> = {}): ToolCall => ({
    name, input, state: 'completed', createdAt: 1, startedAt: 1, completedAt: 2, description: null, ...extra,
});
const fx = (title: string) => {
    const f = TOOL_FIXTURES.find((x) => x.title === title);
    if (!f) throw new Error(`no fixture ${title}`);
    return f.message.tool;
};

describe('commandInfo — one command card for Bash / CodexBash / ACP execute', () => {
    it('reads the command from every runner shape', () => {
        expect(commandInfo(call('Bash', { command: 'ls' }))?.command).toBe('ls');
        expect(commandInfo(call('CodexBash', { command: ['bash', '-lc', 'rg foo'], cwd: '/w' }))).toMatchObject({ command: 'rg foo', cwd: '/w' }) // shell wrapper unwrapped (toolCommand.ts);
        expect(commandInfo(fx('ACP execute (opencode)'))).toMatchObject({ command: 'npm run lint', description: 'Lint the app' });
    });
    it('splits a Gemini execute title into command, cwd and description', () => {
        expect(commandInfo(fx('Gemini execute'))).toEqual({ command: 'ls -la src', cwd: '/home/me/code/app', description: 'List source files' });
    });
    it('is null for non-command tools', () => {
        expect(commandInfo(call('Read', { file_path: 'a' }))).toBeNull();
        expect(commandInfo(fx('ACP search'))).toBeNull();
    });
});

describe('reads', () => {
    it('path and line range from Claude offset/limit and ACP locations', () => {
        expect(readInfo(fx('Read'))).toEqual({ path: '/home/me/code/app/src/session/title.ts', range: '10-14' });
        expect(readInfo(fx('Gemini read'))).toEqual({ path: '/home/me/code/app/package.json', range: null });
    });
    it('strips cat -n prefixes and keeps the first line number', () => {
        expect(stripReadLineNumbers('10\tconst a = 1;\n11\tconst b = 2;')).toEqual({ code: 'const a = 1;\nconst b = 2;', startLine: 10 });
        expect(stripReadLineNumbers('     1→# Title\n     2→')).toEqual({ code: '# Title\n', startLine: 1 });
        // not numbered → untouched
        expect(stripReadLineNumbers('plain\ntext')).toEqual({ code: 'plain\ntext', startLine: 1 });
    });
    it('ACP content arrays and {text} results give their text', () => {
        expect(acpResultText([{ type: 'content', content: { type: 'text', text: 'a' } }, { type: 'text', text: 'b' }])).toBe('a\nb');
        expect(acpResultText({ text: 'out', isError: false })).toBe('out');
        expect(acpResultText({ status: 'completed' })).toBeNull();
    });
});

describe('patchEdits — per-file diffs for every patch shape', () => {
    it('Codex live record, including an added file', () => {
        const edits = patchEdits(fx('CodexPatch (live record)'));
        expect(edits.map((e) => [e.path.split('/').pop(), e.added, e.removed])).toEqual([['title.ts', 1, 1], ['title.test.ts', 5, 0]]);
        expect(edits[0].renders[0]).toMatchObject({ oldText: expect.stringContaining('return s.name;'), newText: expect.stringContaining('s.name ?? s.id') });
    });
    it('Codex history array (not normalised by the CLI)', () => {
        expect(patchEdits(fx('CodexPatch (history array)')).map((e) => e.path)).toEqual(['src/app/title.ts', 'src/app/title.test.ts']);
    });
    it('CodexDiff / GeminiDiff unified diffs, path from the +++ line when not given', () => {
        expect(patchEdits(fx('CodexDiff'))[0]).toMatchObject({ path: 'src/app/title.ts', added: 1, removed: 1 });
        expect(patchEdits(fx('GeminiDiff'))[0]).toMatchObject({ path: 'src/main.ts' });
    });
    it('ACP diff blocks in the result', () => {
        expect(patchEdits(fx('Gemini edit'))[0]).toMatchObject({ path: '/home/me/code/app/src/main.ts', added: 1, removed: 1 });
    });
    it('a still-running patch shows what it proposes', () => {
        expect(patchEdits({ ...fx('CodexPatch (live record)'), state: 'running' })).toHaveLength(2);
    });
});

describe('parseSearchLinks', () => {
    it('Claude WebSearch: the Links line becomes links, the summary stays, boilerplate goes', () => {
        const parsed = parseSearchLinks(fx('WebSearch').result as string)!;
        expect(parsed.links.map((l) => l.title)).toEqual(['Snapshot | Guide | Vitest', 'toMatchInlineSnapshot | API', 'Inline snapshots in Vitest – blog']);
        expect(parsed.rest).toContain('toMatchInlineSnapshot()');
        expect(parsed.rest).not.toContain('REMINDER');
        expect(parsed.rest).not.toContain('Web search results for query');
    });
    it('Jina YAML list and Tavily JSON', () => {
        const jina = parseSearchLinks(acpResultText(fx('jina search_web').result)!)!;
        expect(jina.links).toHaveLength(2);
        expect(jina.links[1]).toMatchObject({ title: 'measureElement and scroll jumps #612', url: 'https://github.com/TanStack/virtual/issues/612' });
        const tavily = parseSearchLinks(fx('tavily_search').result as string)!;
        expect(tavily.links.map((l) => l.url)).toEqual(['https://pnpm.io/filtering', 'https://pnpm.io/cli/recursive']);
        expect(tavily.links[0].snippet).toContain('restrict commands');
    });
    it('null for text with no links', () => {
        expect(parseSearchLinks('Found 3 files')).toBeNull();
        expect(parseSearchLinks('{"ok":true}')).toBeNull();
    });
});

describe('fetch / search parameters', () => {
    it('URL and query from Claude, MCP and ACP shapes', () => {
        expect(fetchUrl(fx('WebFetch'))).toBe('https://vitest.dev/guide/snapshot');
        expect(fetchUrl(fx('jina read_url'))).toBe('https://forums.example.com/t/trust-zdr/27126');
        expect(fetchUrl(fx('ACP fetch'))).toBe('https://agentclientprotocol.com/protocol/tool-calls');
        expect(searchQuery(fx('jina search_web'))).toBe('tanstack virtual dynamic height');
    });
    it('Jina page text → title and body', () => {
        expect(parseFetchedPage('url: https://x\ntitle: Hello\ncontent: >2-\n  Body line\n  two')).toEqual({ title: 'Hello', body: 'Body line\ntwo' });
        expect(parseFetchedPage('# just markdown')).toEqual({ title: null, body: '# just markdown' });
    });
});

describe('toolCardKind', () => {
    it.each([
        ['CodexBash', 'command'], ['Gemini execute', 'command'], ['CodexPatch (live record)', 'patch'], ['Gemini edit', 'patch'],
        ['CodexDiff', 'patch'], ['Gemini read', 'read'], ['ACP search', 'search'], ['ACP fetch', 'fetch'], ['ACP think', 'think'],
        ['CodexReasoning', 'think'], ['Monitor', 'monitor'], ['jina search_web', 'webSearch'], ['tavily_search', 'webSearch'],
        ['jina read_url', 'fetch'], ['unknown MCP, nested input', 'generic'], ['todo list (JSON)', 'generic'], ['McpTool (third-party)', 'generic'],
    ])('%s → %s', (title, kind) => {
        expect(toolCardKind(fx(title))).toBe(kind);
    });
});

describe('toolHeader — verb + key parameter', () => {
    it.each([
        ['Bash', 'Run', 'pnpm -C packages/happy-web-v2 exec tsc --noEmit'],
        ['CodexBash', 'Run', "rg -n 'resolveTitle' src"],
        ['Gemini execute', 'Run', 'ls -la src'],
        ['Read', 'Read', 'title.ts:10-14'],
        ['Write', 'Write', 'notes.md'],
        ['MultiEdit', 'Edit', 'a.ts · 2 edits'],
        ['CodexPatch (live record)', 'Edit', 'title.ts +1'],
        ['Gemini edit', 'Edit', 'main.ts'],
        ['Grep', 'Search', '"resolveTitle" · src'],
        ['Glob', 'Find files', '**/*.test.tsx'],
        ['TodoWrite', 'Update todos', '1/3 done'],
        ['Monitor', 'Watch', 'CI run for PR #690'],
        ['TaskStop', 'Stop task', 'b1vkgxjxr'],
        ['SendMessage', 'Message agent', 'to a8b68ab6… · Re-review PR 655 after fixes'],
        ['ScheduleWakeup', 'Schedule wake-up', 'in 20m · fallback while CI runs'],
        ['jina search_web', 'Search web', 'tanstack virtual dynamic height'],
        ['jina read_url', 'Fetch', 'forums.example.com/t/trust-zdr/27126'],
        ['ACP fetch', 'Fetch', 'agentclientprotocol.com/protocol/tool-calls'],
        ['GeminiReasoning', 'Think', 'Planning the change'],
        ['pi unknown tool', 'web_search', 'acp protocol tool kinds'],
        ['McpTool (third-party)', 'github · search_issues', 'repo:acme/app is:open label:bug'],
        ['unknown MCP, nested input', 'jira · create_issue', null],
    ])('%s', (title, label, detail) => {
        expect(toolHeader(fx(title))).toMatchObject({ label, detail });
    });

    it('leaves Task, Skill and ExitPlanMode to toolInfo', () => {
        expect(toolHeader(call('Agent', { description: 'x' }))).toBeNull();
        expect(toolHeader(call('Skill', { skill: 'x' }))).toBeNull();
        expect(toolHeader(call('ExitPlanMode', { plan: 'x' }))).toBeNull();
    });

    it('tolerates partial input while a call streams', () => {
        for (const name of ['Bash', 'Read', 'MultiEdit', 'CodexPatch', 'SendMessage', 'McpTool', 'execute', 'search', 'other']) {
            expect(() => toolHeader(call(name, undefined))).not.toThrow();
            expect(() => toolHeader(call(name, { acpKind: 'edit', changes: 'oops', locations: 'x' }))).not.toThrow();
        }
    });
});
