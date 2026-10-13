// @vitest-environment happy-dom
/**
 * B-565: a malformed message used to blank the whole transcript (only the
 * route errorElement existed). Each MessageView / ToolView is now its own
 * boundary: the bad row degrades to one line, its siblings render.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message, ToolCallMessage } from '@/sync/typesMessage';

// A tool-card renderer that blows up (stands in for any card-specific bug).
vi.mock('./CommandView', () => ({
    CommandView: ({ command }: { command: string }) => {
        if (command === 'explode') throw new TypeError('card renderer bug');
        return <pre className="cmd">{command}</pre>;
    },
}));

let MessageView: typeof import('./MessageView').MessageView;
let ToolView: typeof import('./ToolView').ToolView;
beforeAll(async () => {
    ({ MessageView } = await import('./MessageView'));
    ({ ToolView } = await import('./ToolView'));
});

const T0 = Date.UTC(2026, 9, 13, 10, 0, 0);
const msg = (id: string, text: unknown): Message => ({ kind: 'agent-text', id, localId: null, createdAt: T0, text } as unknown as Message);

describe('message-level boundaries', () => {
    let host: HTMLDivElement;
    let root: Root;
    let errorSpy: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
        Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
        host = document.createElement('div');
        document.body.append(host);
        root = createRoot(host);
        errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    });
    afterEach(async () => {
        await act(async () => root.unmount());
        host.remove();
        errorSpy.mockRestore();
    });
    const renderRows = (rows: Message[]) => root.render(
        <MemoryRouter initialEntries={['/session/s1']}>
            <Routes><Route path="/session/:id" element={<div>{rows.map((m) => (
                <MessageView key={m.id} message={m} sessionId="s1" showMeta={false} />
            ))}</div>} /></Routes>
        </MemoryRouter>,
    );

    it('one malformed message greys one row; siblings render; a rebuilt message recovers', async () => {
        const good1 = msg('m1', 'alpha body');
        const bad = msg('m2', { not: 'a string' });
        const good3 = msg('m3', 'gamma body');
        await act(async () => renderRows([good1, bad, good3]));
        const alerts = host.querySelectorAll('[data-boundary="message"]');
        expect(alerts).toHaveLength(1);
        expect(host.textContent).toContain('alpha body');
        expect(host.textContent).toContain('gamma body');
        // reducer rebuilds the message with valid content → same id, new object
        await act(async () => renderRows([good1, msg('m2', 'beta fixed'), good3]));
        expect(host.querySelectorAll('[data-boundary="message"]')).toHaveLength(0);
        expect(host.textContent).toContain('beta fixed');
    });

    it('a crashing tool body stays inside its card; the next card renders', async () => {
        const bash = (id: string, command: string) => ({
            kind: 'tool-call', id, localId: null, createdAt: T0, children: [],
            tool: { name: 'Bash', input: { command }, state: 'completed', createdAt: T0, startedAt: T0, completedAt: T0, description: null, result: 'ok' },
        } as unknown as ToolCallMessage);
        await act(async () => root.render(
            <MemoryRouter initialEntries={['/session/s1']}>
                <Routes><Route path="/session/:id" element={<div>
                    <ToolView message={bash('t1', 'explode')} />
                    <ToolView message={bash('t2', 'echo fine')} />
                </div>} /></Routes>
            </MemoryRouter>,
        ));
        expect(host.querySelectorAll('[data-boundary="tool"]')).toHaveLength(1);
        expect(host.querySelector('.cmd')?.textContent).toBe('echo fine');
    });
});
