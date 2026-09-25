import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ToolCallMessage } from '@/sync/typesMessage';
import { installBrowserTestGlobals } from '@/testing/browserTestGlobals';

/**
 * B-499 behaviour: a very-happy built-in tool call renders as a verb row with a
 * human detail and, expanded, as structured fields + result links — never as
 * the generic "Input Parameters" JSON block. Covers the four name shapes the
 * runners produce (Claude mcp__happy__, Codex McpTool, pi piTool, bare).
 */
let ToolGroupView: typeof import('./ToolGroupView').ToolGroupView;

beforeAll(async () => {
    installBrowserTestGlobals();
    ({ ToolGroupView } = await import('./ToolGroupView'));
});

const T0 = 1_700_000_000_000;
function message(id: string, name: string, input: unknown, state: ToolCallMessage['tool']['state'] = 'completed', result?: unknown): ToolCallMessage {
    return {
        kind: 'tool-call', id, localId: null, createdAt: T0, children: [],
        tool: { name, state, input, createdAt: T0, startedAt: T0, completedAt: state === 'running' ? null : T0 + 1000, description: null, result },
    };
}
const mcpText = (value: unknown) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }];

function render(m: ToolCallMessage): string {
    return renderToStaticMarkup(
        <MemoryRouter initialEntries={['/session/s-1']}>
            <Routes><Route path="/session/:id" element={<ToolGroupView tools={[m]} />} /></Routes>
        </MemoryRouter>,
    );
}

describe('built-in tool rows', () => {
    it('Claude delegation: verb label, prose detail, fields and a task link — no raw JSON', () => {
        const html = render(message('d1', 'mcp__happy__team_delegate', {
            goal: 'Ship the automations page', acceptance: ['tests green'], assistant: 'codex', directory: '/w',
        }, 'completed', mcpText({ taskId: 'task-9', team: { id: 'team-1', name: 'core', bots: [], tasks: [{ id: 'task-9', status: 'queued' }] } })));
        expect(html).toContain('Delegate task');
        expect(html).toContain('tg-tool-detail--prose');
        expect(html).toContain('to Codex · Ship the automations page');
        expect(html).toContain('href="/teams/team-1?task=task-9"');
        expect(html).toContain('Open task');
        expect(html).toContain('tests green');
        expect(html).not.toContain('Input Parameters');
        expect(html).not.toContain('"goal"');
    });

    it('Codex McpTool envelope renders the automation card with the trigger in words', () => {
        const html = render(message('a1', 'McpTool', {
            server: 'happy', tool: 'automation_create',
            arguments: { name: 'daily-inventory', trigger: { kind: 'cron', expr: '0 9 * * *', tz: 'Asia/Singapore' }, action: { kind: 'spawn', agent: 'claude', directory: '/home/me/app', prompt: 'Count the things' } },
        }, 'completed', mcpText({ automation: { id: 'auto-1', name: 'daily-inventory', status: 'active', trigger: { kind: 'cron', expr: '0 9 * * *', tz: 'Asia/Singapore' }, action: { kind: 'spawn', agent: 'claude', directory: '/home/me/app', prompt: 'x' } } })));
        expect(html).toContain('Create automation');
        expect(html).toContain('Daily at 09:00 · Asia/Singapore');
        expect(html).toContain('href="/automations/auto-1"');
        expect(html).toContain('Count the things');
        expect(html).toContain('Raw output');
        expect(html).not.toContain('McpTool');
    });

    it('pi piTool envelope and a bare name both resolve; spawn links the new session', () => {
        const pi = render(message('p1', 'other', { piTool: 'session_send', rawInput: { sessionId: 'abcdefgh1234', text: 'run the tests' } }, 'completed', mcpText('Message delivered')));
        expect(pi).toContain('Send to session');
        expect(pi).toContain('abcdefgh1234 · run the tests');
        expect(pi).toContain('href="/session/abcdefgh1234"');
        const bare = render(message('b1', 'session_spawn', { directory: '/w', prompt: 'go' }, 'completed', 'Spawned session zyxwvuts9876 in /w. https://veryhappy.dev/session/zyxwvuts9876'));
        expect(bare).toContain('Spawn session');
        expect(bare).toContain('href="/session/zyxwvuts9876"');
        expect(bare).toContain('Spawned session zyxwvuts9876');
    });

    it('a failed call shows the error, a running call with no arguments shows a placeholder', () => {
        const failed = render(message('e1', 'mcp__happy__automation_create', { name: 'Bad Name' }, 'error', mcpText('automation name must match [a-z0-9][a-z0-9-_.]{0,63}')));
        expect(failed).toContain('tg-row--error');
        expect(failed).toContain('automation name must match');
        expect(failed).not.toContain('Raw output');
        const running = render(message('r1', 'mcp__happy__team_inspect', {}, 'running'));
        expect(running).toContain('Inspect team');
        expect(running).toContain('Waiting for arguments…');
        const partial = render(message('r2', 'mcp__happy__team_delegate', { goal: 'half-streamed goa' }, 'running'));
        expect(partial).toContain('half-streamed goa');
        expect(partial).not.toContain('Waiting for arguments');
    });

    it('title, clipboard and progress are compact one-liners', () => {
        expect(render(message('t1', 'change_title', { title: 'Fix login' }))).toContain('Title changed');
        expect(render(message('t1', 'change_title', { title: 'Fix login' }))).toContain('Fix login');
        const progress = render(message('g1', 'mcp__happy__report_progress', { progress: 'tests green', attention: 'review' }, 'completed', mcpText('Board updated.')));
        expect(progress).toContain('needs review · tests green');
        expect(progress).toContain('Board updated.');
    });

    it('unknown MCP tools keep the generic collapsible view', () => {
        const html = render(message('u1', 'mcp__jira__create_issue', { summary: 'x' }, 'completed', mcpText({ ok: true })));
        expect(html).toContain('jira · create_issue');
        expect(html).toContain('Input Parameters');
    });
});
