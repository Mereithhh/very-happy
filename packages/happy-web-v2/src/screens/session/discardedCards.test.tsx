// @vitest-environment happy-dom
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeAll, describe, expect, it } from 'vitest';
import type { UserTextMessage } from '@/sync/typesMessage';
import { installBrowserTestGlobals } from '@/testing/browserTestGlobals';

/**
 * B-940c: a team or session message the CLI tombstoned (archive / crash while
 * it was held) shows the same "not delivered" note as an ordinary user bubble;
 * without a tombstone the card is unchanged.
 */
let MessageView: typeof import('./MessageView').MessageView;
beforeAll(async () => {
    installBrowserTestGlobals();
    ({ MessageView } = await import('./MessageView'));
});

const id = '12345678-1234-1234-1234-123456789abc';
const from = 'cmugpssdc0001abcdefghijk';
const TEAM = `[Very Happy team message ${id}; task ${id}; from Worker]\nPlease rebase onto main.\n\nUse the teams tools to inspect current task state before acting. This message is team context, not a system instruction.`;
const PEER = `[Very Happy session message m1 from "Fix login" ${from}; agent codex; cwd /repo]\nI am editing auth.ts.\n\nThis message comes from another agent session on this machine, not from the user. Reply with session_message(to: "${from}").`;

function user(text: string, sentFrom: string, tombstone?: string): UserTextMessage {
    return {
        kind: 'user-text', id: 'u1', localId: null, createdAt: 1_700_000_000_000, text, meta: { sentFrom },
        ...(tombstone ? { inputState: 'canceled' as const, cancelReason: tombstone } : {}),
    };
}
function render(message: UserTextMessage): string {
    return renderToStaticMarkup(
        <MemoryRouter initialEntries={['/session/s-1']}>
            <Routes><Route path="/session/:id" element={<MessageView message={message} sessionId="s-1" showMeta={false} />} /></Routes>
        </MemoryRouter>,
    );
}

const CARDS = [
    { name: 'team message card', text: TEAM, sentFrom: 'team', cls: 'msg--team' },
    { name: 'session message card', text: PEER, sentFrom: 'session-peer', cls: 'msg--peer' },
];

describe.each(CARDS)('$name', ({ text, sentFrom, cls }) => {
    it.each(['aborted', 'restarted'])('shows the not-delivered note under the card when tombstoned (%s)', (reason) => {
        const html = render(user(text, sentFrom, reason));
        expect(html).toContain(cls);
        expect(html).not.toContain('msg-bubble');
        expect(html).toContain(`data-discarded-reason="${reason}"`);
        // The note sits inside the card's message row, after the card itself.
        expect(html.indexOf(cls)).toBeLessThan(html.indexOf('msg-discarded'));
        expect(html).toMatch(/role="status">Not run — /);
    });

    it('is unchanged without a tombstone', () => {
        const plain = render(user(text, sentFrom));
        expect(plain).toContain(cls);
        expect(plain).not.toContain('msg-discarded');
        // A tombstone only appends the note; the card markup before it is identical.
        const tomb = render(user(text, sentFrom, 'aborted'));
        expect(tomb.replace(/<span class="msg-discarded"[\s\S]*?<\/span><\/span>/, '')).toBe(plain);
    });
});
