// @vitest-environment happy-dom
/**
 * B-615: a finished turn held in its live shape (reader scrolled up when it
 * ended — see claimJump.test.tsx) keeps its answer inside the activity row.
 * Readers scroll up precisely to read and copy answers, so the held answer
 * must render as its own answer row would: actions (copy / quote / time),
 * meta and live suggestions — on the same node, the other steps unchanged.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '@/sync/typesMessage';

vi.mock('./MessageView', () => ({
    MessageView: (props: { message: Message; showMeta: boolean; showActions?: boolean; optionsActive?: boolean }) => (
        <div
            className="mv"
            data-id={props.message.id}
            data-meta={String(props.showMeta)}
            data-actions={String(props.showActions)}
            data-options={String(props.optionsActive)}
        />
    ),
}));
vi.mock('./ToolGroupView', () => ({ ToolGroupView: () => <div className="tgv" /> }));

import { ActivityMessages } from './ActivityMessages';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const text = (id: string, createdAt: number): Message => ({ kind: 'agent-text', id, localId: null, createdAt, text: id });
const messages = [text('step', 1), text('a1', 2)];

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
});

const props = (id: string) => {
    const el = host.querySelector<HTMLElement>(`.mv[data-id="${id}"]`)!;
    return { meta: el.dataset.meta, actions: el.dataset.actions, options: el.dataset.options };
};

describe('B-615 ActivityMessages: a held answer keeps its own row\'s footer', () => {
    it('steps stay bare; the held answer gets its actions, meta and suggestions', () => {
        act(() => root.render(<ActivityMessages messages={messages} sessionId="s"
            answer={{ id: 'a1', showMeta: true, showActions: true, optionsActive: true }} />));
        expect(props('step')).toEqual({ meta: 'false', actions: 'false', options: 'false' });
        expect(props('a1')).toEqual({ meta: 'true', actions: 'true', options: 'true' });
    });

    it('same node when the hold starts (live → held): only its props change', () => {
        act(() => root.render(<ActivityMessages messages={messages} sessionId="s" />));
        const node = host.querySelector('.mv[data-id="a1"]');
        expect(props('a1')).toEqual({ meta: 'false', actions: 'false', options: 'false' });
        act(() => root.render(<ActivityMessages messages={messages} sessionId="s"
            answer={{ id: 'a1', showMeta: false, showActions: true, optionsActive: false }} />));
        expect(host.querySelector('.mv[data-id="a1"]')).toBe(node);
        expect(props('a1')).toEqual({ meta: 'false', actions: 'true', options: 'false' });
    });
});
