import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ToolCallMessage } from '@/sync/typesMessage';
import type { NormalizedMessage } from '@/sync/typesRaw';
import { installBrowserTestGlobals } from '@/testing/browserTestGlobals';

/**
 * B-771 (QA4 D1/D2): a tool's output travels on `tool-call-end.result` from
 * the CLI. The whole Web path — envelope → normalize → reducer → card — must
 * show it in the B-754 card for that tool, mark a capped result, keep a
 * failed one red, and stay sane for an older CLI that sends no result.
 */
let ToolGroupView: typeof import('./ToolGroupView').ToolGroupView;
let normalizeRawMessage: typeof import('@/sync/typesRaw').normalizeRawMessage;
let createReducer: typeof import('@/sync/reducer/reducer').createReducer;
let reducer: typeof import('@/sync/reducer/reducer').reducer;
let emptyStateKey: typeof import('./toolInfo').emptyStateKey;

// These modules touch browser globals at import time.
beforeAll(async () => {
    installBrowserTestGlobals();
    ({ ToolGroupView } = await import('./ToolGroupView'));
    ({ normalizeRawMessage } = await import('@/sync/typesRaw'));
    ({ createReducer, reducer } = await import('@/sync/reducer/reducer'));
    ({ emptyStateKey } = await import('./toolInfo'));
});

let n = 0;
function session(ev: Record<string, unknown>): NormalizedMessage {
    n += 1;
    const m = normalizeRawMessage(`m${n}`, null, 1000 + n, {
        role: 'session',
        content: { type: 'session', data: { id: `e${n}`, time: 1000 + n, role: 'agent', turn: 'turn-1', ev } },
    } as any);
    if (!m) throw new Error('dropped');
    return m;
}

/** Run one tool call through normalize + reducer; returns the reduced tool message. */
function reduce(name: string, args: Record<string, unknown>, result?: Record<string, unknown> | null): ToolCallMessage {
    const call = `call-${name}-${n}`;
    const msgs = [session({ t: 'tool-call-start', call, name, title: name, description: name, args })];
    if (result !== null) msgs.push(session({ t: 'tool-call-end', call, ...(result ? { result } : {}) }));
    const out = reducer(createReducer(), msgs).messages.find((m) => m.kind === 'tool-call');
    if (!out || out.kind !== 'tool-call') throw new Error('no tool message');
    return out;
}

function render(m: ToolCallMessage): string {
    return renderToStaticMarkup(
        <MemoryRouter initialEntries={['/session/s-1']}>
            <Routes><Route path="/session/:id" element={<ToolGroupView tools={[m]} />} /></Routes>
        </MemoryRouter>,
    );
}

describe('new CLI: tool-call-end.result renders in the tool card', () => {
    it('Bash shows its output', () => {
        const m = reduce('Bash', { command: 'ls -la' }, { text: 'README.md\npackage.json' });
        expect(m.tool.state).toBe('completed');
        const html = render(m);
        expect(html).toContain('class="cmd"');
        expect(html).toContain('README.md');
        expect(html).toContain('package.json');
    });

    it('Read shows the file as code with the cat -n gutter stripped', () => {
        const html = render(reduce('Read', { file_path: '/r/a.ts' }, { text: '     1\texport const a = 1;\n     2\texport const b = 2;' }));
        expect(html).toContain('class="cv cv--ln"');
        expect(html).toContain('export const b = 2;');
        expect(html).not.toContain('     2\t');
    });

    it('WebSearch shows the results as a link list', () => {
        const text = 'Web search results for query: "vh"\n\nLinks: [{"title":"Very Happy","url":"https://veryhappy.dev"}]';
        const html = render(reduce('WebSearch', { query: 'vh' }, { text }));
        expect(html).toContain('tv-links');
        expect(html).toContain('href="https://veryhappy.dev"');
    });

    it('an MCP tool with no arguments shows its result, not 「no output」', () => {
        const html = render(reduce('mcp__jina__primer', {}, { text: '{"time":"10:00","location":"Singapore"}' }));
        expect(html).toContain('Singapore');
        expect(html).not.toContain('No output was produced');
    });

    it('is_error turns the card red with the error text', () => {
        const m = reduce('mcp__jina__primer', {}, { text: 'MCP error -32000: Connection closed', isError: true });
        expect(m.tool.state).toBe('error');
        expect(render(m)).toMatch(/class="tg-error"[^>]*>MCP error -32000: Connection closed/);
    });

    it('a failed Bash shows the error once', () => {
        const html = render(reduce('Bash', { command: 'false' }, { text: 'Exit code 1', isError: true }));
        expect(html.split('Exit code 1').length - 1).toBe(1);
    });

    it('a truncated result says so; an untruncated one does not', () => {
        const capped = reduce('Bash', { command: 'yes' }, { text: 'y\ny', truncated: true });
        expect(capped.tool.resultTruncated).toBe(true);
        expect(render(capped)).toContain('class="tv-truncated"');
        expect(render(reduce('Bash', { command: 'ls' }, { text: 'a' }))).not.toContain('tv-truncated');
    });
});

describe('older CLI: tool-call-end without result', () => {
    it('Bash still renders its command; Edit still renders its diff from the arguments', () => {
        expect(render(reduce('Bash', { command: 'ls -la' }))).toContain('ls -la');
        expect(render(reduce('Edit', { file_path: '/r/a.ts', old_string: 'a', new_string: 'b' }))).toContain('class="dv');
    });

    it('D2: a no-argument MCP tool does not claim 「no output」', () => {
        const done = reduce('mcp__jina__primer', {});
        expect(done.tool.state).toBe('completed');
        const html = render(done);
        expect(html).not.toContain('No output was produced');
        expect(html).toContain('No arguments');
    });
});

describe('emptyStateKey (D2)', () => {
    it('running → running; no reported result → no arguments; empty reported result → no output', () => {
        expect(emptyStateKey({ state: 'running', result: undefined })).toBe('tools.fullView.running');
        expect(emptyStateKey({ state: 'completed', result: null })).toBe('tools.card.noDetails');
        expect(emptyStateKey({ state: 'completed', result: undefined })).toBe('tools.card.noDetails');
        expect(emptyStateKey({ state: 'completed', result: '' })).toBe('tools.fullView.noOutput');
    });

    it('a running no-argument MCP card says it is running', () => {
        expect(render(reduce('mcp__jina__primer', {}, null))).toContain('Tool is running');
    });
});
