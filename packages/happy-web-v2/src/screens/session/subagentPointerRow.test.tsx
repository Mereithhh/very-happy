import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Message, ToolCallMessage } from '@/sync/typesMessage';
import { installBrowserTestGlobals } from '@/testing/browserTestGlobals';

/**
 * B-317 behaviour: inside a session, an Agent/Task row is a one-line POINTER
 * into the drawer. The old row unfolded a 40-line prompt and a 50-line tool log
 * between two paragraphs of the main conversation — that is what the Owner
 * reported as "感觉很奇怪".
 */
let runningSubagentCards: typeof import('./SubagentDock').runningSubagentCards;
let liveSubagentDockCards: typeof import('./SubagentDock').liveSubagentDockCards;
let ToolGroupView: typeof import('./ToolGroupView').ToolGroupView;
let ActivityMessages: typeof import('./ActivityMessages').ActivityMessages;

beforeAll(async () => {
    installBrowserTestGlobals();
    ({ ToolGroupView } = await import('./ToolGroupView'));
    ({ runningSubagentCards } = await import('./SubagentDock'));
    ({ liveSubagentDockCards } = await import('./SubagentDock'));
    ({ ActivityMessages } = await import('./ActivityMessages'));
});

const T0 = 1_700_000_000_000;

function taskCard(): ToolCallMessage {
    return {
        kind: 'tool-call',
        id: 'task-1',
        localId: null,
        createdAt: T0,
        children: [],
        subagent: { status: 'running', subagentType: 'general-purpose', updatedAt: T0 },
        tool: {
            name: 'Task',
            state: 'running',
            input: {
                sessionSubagent: 'sub-1',
                description: 'Check the TPM config',
                prompt: 'A VERY LONG BRIEFING THAT MUST NOT LAND IN THE TRANSCRIPT',
            },
            createdAt: T0,
            startedAt: T0,
            completedAt: null,
            description: null,
        },
    };
}

function inSession(node: React.ReactNode): string {
    return renderToStaticMarkup(
        <MemoryRouter initialEntries={['/session/s1']}>
            <Routes><Route path="/session/:id" element={<>{node}</>} /></Routes>
        </MemoryRouter>,
    );
}

function withoutSession(node: React.ReactNode): string {
    return renderToStaticMarkup(<MemoryRouter>{node}</MemoryRouter>);
}

describe('sub-agent row (B-317)', () => {
    it('is a pointer inside a session: no prompt, no disclosure panel', () => {
        const html = inSession(<ToolGroupView tools={[taskCard()]} />);
        expect(html).toContain('tg-subagent-open');
        expect(html).toContain('Check the TPM config');
        expect(html).not.toContain('A VERY LONG BRIEFING');
        expect(html).not.toContain('vh-disclosure-panel');
    });

    it('still says what the sub-agent is doing while collapsed', () => {
        const html = inSession(<ToolGroupView tools={[taskCard()]} />);
        expect(html).toContain('tg-subagent-meta');
        expect(html).toContain('vh-spinner');
        expect(html).not.toContain('tg-subagent-line');
    });

    it('an aborted sub-agent stops pulsing and reads as stopped', () => {
        const html = inSession(<ToolGroupView tools={[taskCard()]} abortedAt={T0 + 5} />);
        expect(html).not.toContain('vh-spinner');
        // The group spine's own live/stalled state is ChatList's job (B-295);
        // what this row owns is the sub-agent glyph and its summary line.
        expect(html).toContain('<span>stopped</span>');
        expect(html).toContain('lucide-square');
    });


    it('renders a completed open_preview as a direct file entry without duplicated generic tool chrome', () => {
        const preview = taskCard(); preview.tool = {...preview.tool,name:'mcp__happy__open_preview',state:'completed',input:{path:'/workspace/review.md'}}; delete preview.subagent;
        const html = inSession(<ToolGroupView tools={[preview]} />);
        expect(html).toContain('tg-preview-row');
        expect(html).toContain('/workspace/review.md');
        expect(html).not.toContain('vh-disclosure-panel');
        preview.tool.state='error';
        const failed=inSession(<ToolGroupView tools={[preview]} />);
        expect(failed).not.toContain('tg-preview-row');
        expect(failed).toContain('vh-disclosure-panel');
    });

    it('keeps failure text accessible for older wrappers without lifecycle events', () => {
        const card=taskCard();delete card.subagent;card.tool.state='error';
        const html=inSession(<ToolGroupView tools={[card]} />);
        expect(html).toContain('<span>failed</span>');
        expect(html).toContain('tg-subagent-open--failed');
    });

    it('falls back to the inline detail where there is no drawer to open', () => {
        const html = withoutSession(<ToolGroupView tools={[taskCard()]} />);
        expect(html).not.toContain('tg-subagent-open');
        expect(html).toContain('vh-disclosure-panel');
        // The briefing opens by default; the full detail still has a disclosure.
        expect(html).toContain('A VERY LONG BRIEFING');
    });

    it('keeps nested task details readable without navigating through the parent message index', () => {
        const html = inSession(<ActivityMessages messages={[taskCard()]} sessionId="s1" subagentNavigation="inline" />);
        expect(html).not.toContain('tg-subagent-open');
        expect(html).toContain('A VERY LONG BRIEFING');
        expect(html).toContain('vh-disclosure-panel');
    });

    it('keeps Codex child collaboration input readable instead of offering a broken parent-index link', () => {
        const card = taskCard();
        card.tool = {...card.tool, name: 'CodexCollaboration', input: {operation: 'spawn', receiverThreadIds: ['grandchild-thread'], prompt: 'Grandchild task'}};
        delete card.subagent;
        const parent = inSession(<ActivityMessages messages={[card]} sessionId="s1" />);
        expect(parent).toContain('sa-dock-item');
        const nested = inSession(<ActivityMessages messages={[card]} sessionId="s1" subagentNavigation="inline" />);
        expect(nested).not.toContain('sa-dock-item');
        expect(nested).toContain('grandchild-thread');
        expect(nested).toContain('Grandchild task');
    });
});

describe('subagent dock lifecycle', () => {
    const online = {presence: 'online' as const, thinking: false, heartbeatFresh: true};

    it('shows a current-turn background task while its wrapper is online', () => {
        const card = taskCard();
        card.tool.state = 'completed';
        expect(liveSubagentDockCards([card], online)).toEqual([card]);
    });

    it('removes live dock entries when the wrapper is offline, archived, or its thinking heartbeat expires', () => {
        const card = taskCard();
        expect(liveSubagentDockCards([card], {...online, presence: T0})).toEqual([]);
        expect(liveSubagentDockCards([card], {...online, archivedAt: T0 + 1})).toEqual([]);
        expect(liveSubagentDockCards([card], {...online, thinking: true, heartbeatFresh: false})).toEqual([]);
        expect(card.subagent?.status).toBe('running');
    });

    it('does not resurrect a historical running card during a new turn', () => {
        const card = taskCard();
        const nextTurn: Message = {kind: 'user-text', id: 'next', localId: null, createdAt: T0 + 1, text: 'Next task'};
        expect(liveSubagentDockCards([card, nextTurn], {...online, thinking: true})).toEqual([]);
        expect(card.subagent?.status).toBe('running');
    });

    it('retains asynchronous running cards after their launch tool completes, excluding finished and unknown cards', () => {
        const live = taskCard();
        live.tool.state = 'completed';
        const done = taskCard(); done.id = 'done'; done.subagent = { ...done.subagent!, status: 'completed' };
        const unknown = taskCard(); unknown.id = 'unknown'; delete unknown.subagent;
        expect(runningSubagentCards([live, done, unknown]).map(m => m.id)).toEqual(['task-1']);
    });
    it('removes a task as soon as its lifecycle stops', () => {
        const card = taskCard();
        expect(runningSubagentCards([card])).toHaveLength(1);
        card.subagent = { ...card.subagent!, status: 'stopped' };
        expect(runningSubagentCards([card])).toEqual([]);
    });
});
