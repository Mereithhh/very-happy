// @vitest-environment happy-dom
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Message, ToolCallMessage } from '@/sync/typesMessage';
import { compactMessageTime, messageTimestamp, messageTimestampRange } from './messageTimestamp';

let MessageView: typeof import('./MessageView').MessageView;
let ToolGroupView: typeof import('./ToolGroupView').ToolGroupView;
let ActivityMessages: typeof import('./ActivityMessages').ActivityMessages;
beforeAll(async () => {
    ({ MessageView } = await import('./MessageView'));
    ({ ToolGroupView } = await import('./ToolGroupView'));
    ({ ActivityMessages } = await import('./ActivityMessages'));
});

const T0 = Date.UTC(2026, 8, 11, 12, 34, 56);
function text<K extends 'user-text' | 'agent-text'>(kind: K, createdAt = T0) {
    return { kind, id: `${kind}-${createdAt}`, localId: null, createdAt, text: 'Message body' };
}
function tool(id: string, createdAt = T0): ToolCallMessage {
    return {
        kind: 'tool-call', id, localId: null, createdAt, children: [],
        tool: { name: 'Bash', input: { command: `echo ${id}` }, state: 'completed',
            createdAt, startedAt: createdAt, completedAt: createdAt + 5000, description: null, result: 'done' },
    };
}
function render(node: React.ReactNode) {
    const host = document.createElement('div');
    host.innerHTML = renderToStaticMarkup(<MemoryRouter initialEntries={['/session/s1']}>
        <Routes><Route path="/session/:id" element={<>{node}</>} /></Routes>
    </MemoryRouter>);
    return host;
}

describe('message timestamps', () => {
    it.each([
        text('user-text'), text('agent-text'),
        { ...text('user-text'), text: '<command-name>/status</command-name>' },
        { ...text('user-text'), text: '<attached_files>\n{"path":"/repo/report.md","name":"report.md"}\n</attached_files>' },
    ] satisfies Message[])('places a visible time in the $kind footer', message => {
        const host = render(<MessageView message={message} sessionId="s1" showMeta={false} />);
        const time = host.querySelector('.msg-actions time');
        expect(time?.textContent).toBe(compactMessageTime(T0, 'en'));
        expect(time?.getAttribute('datetime')).toBe(new Date(T0).toISOString());
        expect(time?.getAttribute('title')).toBe(messageTimestamp(T0, 'en'));
    });

    it('includes the date, seconds and local timezone without changing the source timestamp', () => {
        expect(messageTimestamp(T0, 'en', 'UTC')).toBe('09/11/2026, 12:34:56 UTC');
        const chinese = messageTimestamp(T0, 'zh-Hans', 'Asia/Singapore');
        for (const part of ['2026/09/11', '20:34:56', 'GMT+8']) expect(chinese).toContain(part);
        expect(messageTimestamp(T0, 'en', 'UTC')).toBe('09/11/2026, 12:34:56 UTC');
    });

    it.each([undefined, null, NaN, Infinity, -1, 0, 1e20])('does not invent a time for %s', createdAt => {
        expect(messageTimestamp(createdAt, 'en')).toBeUndefined();
    });

    it('describes all known creation times in a collapsed group, even with unsorted input', () => {
        expect(messageTimestampRange([T0 + 60_000, null, T0], 'en', 'UTC'))
            .toBe('09/11/2026, 12:34:56 UTC – 09/11/2026, 12:35:56 UTC');
        expect(messageTimestampRange([T0, T0, NaN], 'en', 'UTC')).toBe(messageTimestamp(T0, 'en', 'UTC'));
        expect(messageTimestampRange([T0, T0 + 999], 'en', 'UTC')).toBe(messageTimestamp(T0, 'en', 'UTC'));
        expect(messageTimestampRange([null, NaN, 0], 'en')).toBeUndefined();
    });

    it.each([
        text('user-text'), text('agent-text'),
        { ...text('agent-text'), isThinking: true },
        { ...text('user-text'), meta: { sentFrom: 'team' } },
        { kind: 'agent-event', id: 'event', createdAt: T0, event: { type: 'switch', mode: 'local' } },
        { kind: 'agent-event', id: 'auth', createdAt: T0, event: { type: 'message', kind: 'claude-auth-failed', message: 'Authentication failed' } },
    ] satisfies Message[])('shows the creation time for the $kind leaf without a new layout wrapper', message => {
        const host = render(<MessageView message={message} sessionId="s1" showMeta={false} />);
        expect(host.firstElementChild?.classList.contains('msg')).toBe(true);
        expect(host.firstElementChild?.getAttribute('title')).toBe(messageTimestamp(T0, 'en'));
        const copy = host.querySelector<HTMLButtonElement>('button.vh-copy');
        if (copy) expect(copy.title).toBe('Copy message');
    });

    it('leaves unavailable times absent and does not make hidden events visible', () => {
        const host = render(<MessageView message={text('agent-text', 0)} sessionId="s1" showMeta={false} />);
        expect(host.querySelector('.msg')?.hasAttribute('title')).toBe(false);
        expect(render(<MessageView message={{ kind: 'agent-event', id: 'ready', createdAt: T0, event: { type: 'ready' } }} sessionId="s1" showMeta={false} />).innerHTML).toBe('');
    });

    it('keeps per-tool times beneath a group header and preserves the command hint', () => {
        const tools = [tool('first'), tool('second', T0 + 60_000)];
        tools[0].tool.state = 'running';
        const host = render(<ToolGroupView tools={tools} />);
        expect(host.querySelector('.tg-head')?.getAttribute('title')).toBe(messageTimestampRange(tools.map(m => m.createdAt), 'en'));
        expect([...host.querySelectorAll('.tg-row')].map(row => row.getAttribute('title')))
            .toEqual(tools.map(m => messageTimestamp(m.createdAt, 'en')));
        expect(host.querySelector('.tg-run-summary')?.getAttribute('title')).toBe('echo second');
    });

    it('gives completed previews and subagent pointers their own message time', () => {
        const preview = tool('preview');
        preview.tool = { ...preview.tool, name: 'mcp__happy__open_preview', input: { path: '/workspace/report.md' } };
        expect(render(<ToolGroupView tools={[preview]} />).querySelector('.tg-preview-row')?.getAttribute('title'))
            .toBe(messageTimestamp(T0, 'en'));
        const task = tool('task', T0 + 1000);
        task.tool = { ...task.tool, name: 'Task', input: { description: 'Inspect the config' } };
        const host = render(<ToolGroupView tools={[task]} />);
        expect(host.querySelector('.tg-subagent-open')?.parentElement?.getAttribute('title')).toBe(messageTimestamp(T0 + 1000, 'en'));
    });

    it('uses child message times and does not borrow a later lifecycle update for a retained result', () => {
        const parent = tool('task');
        parent.tool = { ...parent.tool, name: 'Task', input: { prompt: 'Task briefing' } };
        parent.children = [text('agent-text', T0 + 10_000), text('agent-text', 0), tool('child-tool', T0 + 20_000)];
        // Resumed work can advance updatedAt while the reducer retains an older result.
        parent.subagent = { status: 'running', updatedAt: T0 + 30_000, result: { text: 'Earlier result' } };
        const host = render(<ActivityMessages messages={[parent]} sessionId="s1" subagentNavigation="inline" />);
        // A completed single tool is collapsed in ActivityMessages; direct ToolGroupView opens it.
        const expanded = render(<ToolGroupView tools={[parent]} />);
        expect(host.querySelector('.tg-row')?.getAttribute('title')).toBe(messageTimestamp(T0, 'en'));
        // Without a session drawer, the real shared detail is rendered inline.
        const details = document.createElement('div');
        details.innerHTML = renderToStaticMarkup(<MemoryRouter><ToolGroupView tools={[parent]} /></MemoryRouter>);
        expect(expanded.querySelector('.tg-subagent-open')).not.toBeNull();
        expect(details.querySelector('.sa')?.getAttribute('title')).toBe('');
        expect(details.querySelector('.sa-brief')?.getAttribute('title')).toBe(messageTimestamp(T0, 'en'));
        expect([...details.querySelectorAll('.sa-log .msg')].map(node => node.getAttribute('title')))
            .toEqual([null, messageTimestamp(T0 + 10_000, 'en')]);
        expect(details.querySelector('.sa-log .tg-row')?.getAttribute('title')).toBe(messageTimestamp(T0 + 20_000, 'en'));
        expect(details.querySelector('.sa-result')?.textContent).toContain('Earlier result');
        expect(details.querySelector('.sa-result')?.hasAttribute('title')).toBe(false);
    });
});
