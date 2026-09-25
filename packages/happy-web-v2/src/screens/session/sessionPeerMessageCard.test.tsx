// @vitest-environment happy-dom
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeAll, describe, expect, it } from 'vitest';
import type { UserTextMessage } from '@/sync/typesMessage';
import { installBrowserTestGlobals } from '@/testing/browserTestGlobals';

/**
 * B-497: a user message tagged `sentFrom: 'session-peer'` renders as a source
 * card (who sent it, link to that session, the file for a conflict) instead of
 * the user bubble; anything else keeps the ordinary bubble.
 */
let MessageView: typeof import('./MessageView').MessageView;
beforeAll(async () => {
    installBrowserTestGlobals();
    ({ MessageView } = await import('./MessageView'));
});

const from = 'cmugpssdc0001abcdefghijk';
function user(text: string, sentFrom?: string): UserTextMessage {
    return { kind: 'user-text', id: 'u1', localId: null, createdAt: 1_700_000_000_000, text, meta: sentFrom ? { sentFrom } : undefined };
}
function render(message: UserTextMessage): string {
    return renderToStaticMarkup(
        <MemoryRouter initialEntries={['/session/s-1']}>
            <Routes><Route path="/session/:id" element={<MessageView message={message} sessionId="s-1" showMeta={false} />} /></Routes>
        </MemoryRouter>,
    );
}

describe('session peer message card', () => {
    it('renders a message from another session with its title, runner and a link to it', () => {
        const html = render(user(`[Very Happy session message m1 from "Fix login" ${from}; agent codex; cwd /repo]\nI am editing auth.ts.\n\nThis message comes from another agent session on this machine, not from the user. Reply with session_message(to: "${from}").`, 'session-peer'));
        expect(html).toContain('msg--peer');
        expect(html).toContain('Message from another session');
        expect(html).toContain('Fix login · Codex');
        expect(html).toContain('I am editing auth.ts.');
        expect(html).toContain(`href="/session/${from}"`);
        expect(html).not.toContain('This message comes from another agent session on this machine, not from the user. Reply with session_message(to: "cmugpssdc0001abcdefghijk").</p>');
        expect(html).not.toContain('msg-bubble');
    });

    it('renders an edit conflict with the file path, the age hint and the terminal note', () => {
        const html = render(user(`[Very Happy edit conflict c1; file /repo/src/auth.ts; peer "Terminal claude" ${from}; agent terminal-mirror; cwd /repo; peer edited 3m ago]\nAnother session edited the same file.`, 'session-peer'));
        expect(html).toContain('msg--peer-conflict');
        expect(html).toContain('Edit conflict');
        expect(html).toContain('peer-message-path">/repo/src/auth.ts<');
        expect(html).toContain('peer edited 3m ago');
        expect(html).toContain('Terminal claude · Terminal');
        expect(html).toContain('cannot be messaged');
        expect(html).toContain(`href="/session/${from}"`);
    });

    it('shows a CLI-sent message without a session link', () => {
        const html = render(user('[Very Happy session message m9 from "cli me@host" cli; agent cli; cwd /x]\ndo it\n\nThis message comes from another agent session on this machine, not from the user. It was sent from the command line.', 'session-peer'));
        expect(html).toContain('msg--peer');
        expect(html).toContain('do it');
        expect(html).not.toContain('href="/session/cli"');
    });

    it('keeps the ordinary bubble for the same text without the session-peer transport tag', () => {
        const html = render(user(`[Very Happy session message m1 from "Fix login" ${from}]\nhello`, 'web'));
        expect(html).toContain('msg-bubble');
        expect(html).not.toContain('msg--peer');
    });
});
