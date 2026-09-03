import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ToolCallMessage } from '@/sync/typesMessage';
import { installBrowserTestGlobals } from '@/testing/browserTestGlobals';

/**
 * B-317 behaviour: inside a session, an Agent/Task row is a one-line POINTER
 * into the drawer. The old row unfolded a 40-line prompt and a 50-line tool log
 * between two paragraphs of the main conversation — that is what the Owner
 * reported as "感觉很奇怪".
 */
let ToolGroupView: typeof import('./ToolGroupView').ToolGroupView;

beforeAll(async () => {
    installBrowserTestGlobals();
    ({ ToolGroupView } = await import('./ToolGroupView'));
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
        expect(html).toContain('tg-subagent-line');
        expect(html).toContain('vh-dot--pulse');
    });

    it('an aborted sub-agent stops pulsing and reads as stopped', () => {
        const html = inSession(<ToolGroupView tools={[taskCard()]} abortedAt={T0 + 5} />);
        expect(html).not.toContain('vh-dot--pulse');
        // The group spine's own live/stalled state is ChatList's job (B-295);
        // what this row owns is the sub-agent glyph and its summary line.
        expect(html).toContain('tg-subagent-line">stopped ·');
        expect(html).toContain('lucide-square');
    });

    it('falls back to the inline detail where there is no drawer to open', () => {
        const html = withoutSession(<ToolGroupView tools={[taskCard()]} />);
        expect(html).not.toContain('tg-subagent-open');
        expect(html).toContain('vh-disclosure-panel');
        // The prompt is a closed disclosure even inline — never a raw dump.
        expect(html).not.toContain('A VERY LONG BRIEFING');
    });
});
