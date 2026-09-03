import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ToolCallMessage } from '@/sync/typesMessage';

/**
 * B-295 behaviour, not source text: a tool call whose wrapper died keeps
 * `state: 'running'` forever, and the group used to render it as a live,
 * ticking, phosphor-teal run — "耗时 2094 分钟" on a session that had been
 * restarted a day earlier.
 *
 * `ToolGroupView` is imported lazily because the i18n module reads MMKV
 * (localStorage) at import time and vitest runs in the node environment.
 */
let ToolGroupView: typeof import('./ToolGroupView').ToolGroupView;

beforeAll(async () => {
    const store = new Map<string, string>();
    (globalThis as Record<string, unknown>).localStorage = {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
        clear: () => store.clear(),
        key: () => null,
        length: 0,
    };
    ({ ToolGroupView } = await import('./ToolGroupView'));
});

function runningTool(id: string, name: string): ToolCallMessage {
    return {
        kind: 'tool-call',
        id,
        localId: null,
        createdAt: 1_700_000_000_000,
        children: [],
        tool: {
            name,
            state: 'running',
            input: {},
            createdAt: 1_700_000_000_000,
            startedAt: 1_700_000_000_000,
            completedAt: null,
            description: null,
        },
    };
}

function render(node: React.ReactNode): string {
    return renderToStaticMarkup(<MemoryRouter>{node}</MemoryRouter>);
}

describe('ToolGroupView stalled state', () => {
    const tools = [runningTool('t1', 'Bash'), runningTool('t2', 'Read')];

    it('a live group keeps the running accent and the elapsed timer', () => {
        const html = render(<ToolGroupView tools={tools} />);
        expect(html).toContain('tg--running');
        expect(html).toContain('tg-elapsed--live');
        expect(html).not.toContain('tg--stalled');
        expect(html).not.toContain('Unfinished');
    });

    it('a stalled group drops the accent and the timer, and says unfinished', () => {
        const html = render(<ToolGroupView tools={tools} stalled />);
        expect(html).toContain('tg--stalled');
        expect(html).toContain('Unfinished');
        expect(html).not.toContain('tg--running');
        expect(html).not.toContain('tg-elapsed--live');
    });

    it('a single stalled tool row loses its pulse too', () => {
        const live = render(<ToolGroupView tools={[tools[0]]} />);
        const stalled = render(<ToolGroupView tools={[tools[0]]} stalled />);
        expect(live).toContain('tg--running');
        expect(stalled).toContain('tg--stalled');
        expect(stalled).toContain('tg-tool-stalled');
        expect(stalled).not.toContain('tg--running');
        // the pulse is the phosphor-teal "live" accent — it must be gone
        expect(live).toContain('vh-dot--pulse');
        expect(stalled).not.toContain('vh-dot--pulse');
    });

    it('completed tools are untouched by the flag', () => {
        const done: ToolCallMessage = {
            ...tools[0],
            tool: { ...tools[0].tool, state: 'completed', completedAt: 1_700_000_000_100 },
        };
        expect(render(<ToolGroupView tools={[done]} stalled />)).not.toContain('tg--stalled');
    });
});
