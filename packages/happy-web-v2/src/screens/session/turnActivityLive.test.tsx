import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { beforeAll, describe, expect, it } from 'vitest';
import type { AgentTextMessage, ToolCallMessage } from '@/sync/typesMessage';
import { installBrowserTestGlobals } from '@/testing/browserTestGlobals';

/**
 * B-376 behaviour, not source text. The web has one liveness signal — the
 * wrapper's 2s keepAlive `thinking` lease (`sync/agentLiveness.ts`) — and the
 * turn activity view folds and its timing header turns into "… then done" the
 * moment that lease reads `false`. The failure this guards against is the
 * ACP (pi) runner releasing the lease mid-turn, which made the web show "done"
 * while pi was still working.
 *
 * `TurnActivityView` expands when `live` is true and folds on the live→done
 * edge. While a turn is genuinely live it must stay expanded even as tool
 * calls complete; the header reports an unconditionally live elapsed time.
 */
let TurnActivityView: typeof import('./TurnActivityView').TurnActivityView;

beforeAll(async () => {
    installBrowserTestGlobals();
    ({ TurnActivityView } = await import('./TurnActivityView'));
});

function render(node: React.ReactNode): string {
    return renderToStaticMarkup(<MemoryRouter>{node}</MemoryRouter>);
}

function runningTool(id: string, name: string, startedAt: number): ToolCallMessage {
    return {
        kind: 'tool-call',
        id,
        localId: null,
        createdAt: startedAt,
        children: [],
        tool: {
            name,
            state: 'running',
            input: {},
            createdAt: startedAt,
            startedAt,
            completedAt: null,
            description: null,
        },
    };
}

function completedTool(id: string, name: string, startedAt: number, completedAt: number): ToolCallMessage {
    return {
        kind: 'tool-call',
        id,
        localId: null,
        createdAt: startedAt,
        children: [],
        tool: {
            name,
            state: 'completed',
            input: {},
            createdAt: startedAt,
            startedAt,
            completedAt,
            description: null,
        },
    };
}

function assistantText(id: string, text: string, createdAt: number): AgentTextMessage {
    return {
        kind: 'agent-text',
        id,
        localId: null,
        createdAt,
        text,
    };
}

describe('TurnActivityView live turn', () => {
    const messages: ToolCallMessage[] | AgentTextMessage[] = [
        runningTool('tool-running', 'Bash', 1_400),
        completedTool('tool-done', 'Read', 2_000, 3_000),
    ];

    const baseProps = {
        messages,
        sessionId: 'session-s1',
    };

    it('a running turn stays expanded with the live elapsed header, even when a tool inside it has completed', () => {
        const html = render(
            <TurnActivityView {...baseProps} live />,
        );
        const head = html.match(/<button type="button" class="ta-head[^"]*"[^>]*>/)?.[0] ?? '';
        // The turn's own disclosure header is open (its activity detail renders).
        expect(html).toContain('ta-detail');
        expect(html).toContain('ta--live');
        expect(head).toContain('aria-expanded="true"');
        // Only the live turn wears the live flag on the section itself.
        expect(html).toMatch(/<section class="ta ta--live">/);
        // Live turns tick their own clock; the tail row's frozen duration is not
        // consulted (it is meaningless while the turn is still running).
        const withStaleDuration = render(
            <TurnActivityView {...baseProps} live durationSeconds={1} />,
        );
        expect(withStaleDuration).toMatch(/<section class="ta ta--live">/);
        expect(withStaleDuration).toContain('ta-detail');
    });

    it('once live goes false the same turn folds and drops the live header', () => {
        const html = render(
            <TurnActivityView {...baseProps} live={false} />,
        );
        expect(html).not.toContain('ta-detail');
        expect(html).not.toContain('ta--live');
        expect(html).toMatch(/<button type="button" class="ta-head[^"]*" aria-expanded="false"/);
    });

    it('intermediate prose between tools has no copy or quote action region', () => {
        const html = render(<TurnActivityView sessionId="session-s1" live messages={[completedTool('first', 'Read', 1, 2), assistantText('progress', 'Checking the next file', 3), runningTool('second', 'Read', 4)]} />);
        expect(html).toContain('Checking the next file');
        expect(html).not.toContain('msg-actions');
    });

    it('a completed-only turn is folded from the start (nothing running)', () => {
        const doneOnly = [completedTool('tool-done', 'Read', 2_000, 3_000), assistantText('ans', 'answer', 4_000)];
        const html = render(
            <TurnActivityView messages={doneOnly} sessionId="session-s1" live={false} />,
        );
        expect(html).not.toContain('ta-detail');
        expect(html).not.toContain('ta--live');
    });
});
