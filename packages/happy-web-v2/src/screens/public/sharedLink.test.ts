import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { ensureShareLinkMeta, pollFailureClears, mergeRecords, messagesFromRecords, phaseForStatus, pollIntervalMs, secretFromHash } from './sharedLink';

describe('B-701 share-link viewer helpers', () => {
    it('reads the secret from the fragment and rejects junk', () => {
        const secret = 'A'.repeat(43);
        expect(secretFromHash(`#${secret}`)).toBe(secret);
        expect(secretFromHash(`#s=${secret}`)).toBe(secret);
        expect(secretFromHash('')).toBeNull();
        expect(secretFromHash('#short')).toBeNull();
        expect(secretFromHash('#<script>alert(1)</script>xxxxxxxxxxxxxxxx')).toBeNull();
    });

    it('treats revoked and expired (410) the same, distinct from an unknown link', () => {
        expect(phaseForStatus(410)).toBe('gone');
        expect(phaseForStatus(404)).toBe('invalid');
        expect(phaseForStatus(429)).toBe('rateLimited');
        expect(phaseForStatus(500)).toBe('error');
    });

    it('a poll failure clears the page only for gone / invalid, never for a network blip or throttling', () => {
        expect(pollFailureClears(410)).toBe(true);
        expect(pollFailureClears(404)).toBe(true);
        expect(pollFailureClears(429)).toBe(false);
        expect(pollFailureClears(502)).toBe(false);
        expect(pollFailureClears(null)).toBe(false);
    });

    it('polls within the 5 s revocation bound', () => {
        expect(pollIntervalMs('live')).toBeLessThanOrEqual(5_000);
        expect(pollIntervalMs('snapshot')).toBeLessThanOrEqual(5_000);
    });

    it('merges pages by seq without duplicates', () => {
        const r = (seq: number) => ({ id: `m${seq}`, seq, createdAt: seq, content: {} });
        expect(mergeRecords([r(1), r(2)], [r(2), r(3)]).map((x) => x.seq)).toEqual([1, 2, 3]);
        expect(mergeRecords([r(3)], [r(1)]).map((x) => x.seq)).toEqual([1, 3]);
    });

    it('renders projected records through the normal reducer', () => {
        const messages = messagesFromRecords([
            { id: 'a', seq: 1, createdAt: 1, content: { role: 'user', content: { type: 'text', text: 'hello' } } },
            { id: 'b', seq: 2, createdAt: 2, content: { role: 'agent', content: { type: 'output', data: { type: 'assistant', message: { role: 'assistant', model: 'm', content: [{ type: 'text', text: 'hi there' }] }, uuid: 'u1', parentUuid: null } } } },
            { id: 'c', seq: 3, createdAt: 3, content: { role: 'nonsense' } },
        ]);
        const texts = messages.map((m) => ('text' in m ? m.text : null));
        expect(texts).toContain('hello');
        expect(texts).toContain('hi there');
    });

    it('adds noindex / no-referrer metas once', () => {
        const metas: Array<{ name: string; content: string }> = [];
        const doc = {
            createElement: () => ({ name: '', content: '' }),
            head: {
                querySelector: (sel: string) => metas.find((m) => sel.includes(`"${m.name}"`)) ?? null,
                prepend: (m: { name: string; content: string }) => { metas.unshift(m); },
            },
        } as unknown as Document;
        ensureShareLinkMeta(doc);
        ensureShareLinkMeta(doc);
        expect(metas).toEqual([{ name: 'referrer', content: 'no-referrer' }, { name: 'robots', content: 'noindex, nofollow' }]);
    });

    // Security review: the anonymous viewer never sends this browser's account
    // credentials — opens are anonymous and a token must not leave the app.
    it('the viewer page never reads stored credentials or sends Authorization', () => {
        const src = readFileSync(new URL('./SharedLinkScreen.tsx', import.meta.url), 'utf8') + readFileSync(new URL('./sharedLink.ts', import.meta.url), 'utf8');
        expect(src).not.toMatch(/auth_credentials|TokenStorage|authorization:|apiSocket/);
        expect(src).toContain("credentials: 'omit'");
    });

    // B-745: the server now returns role=session records in the wire shape (`content` IS the envelope).
    it('renders wire-shaped role=session records (assistant text and tool calls)', () => {
        const env = (id: string, ev: Record<string, unknown>) => ({ role: 'session', content: { id, time: 2, role: 'agent', turn: 't1', ev } });
        const messages = messagesFromRecords([
            { id: 'a', seq: 1, createdAt: 1, content: { role: 'user', content: { type: 'text', text: 'hello' } } },
            { id: 'b', seq: 2, createdAt: 2, content: env('e1', { t: 'turn-start' }) },
            { id: 'c', seq: 3, createdAt: 2, content: env('e2', { t: 'text', text: 'assistant reply' }) },
            { id: 'd', seq: 4, createdAt: 2, content: env('e3', { t: 'tool-call-start', call: 'c1', name: 'Bash', title: 'env', description: 'env', args: { command: 'env' } }) },
        ]);
        expect(messages.map((m) => ('text' in m ? m.text : null))).toContain('assistant reply');
        expect(messages.some((m) => m.kind === 'tool-call' && m.tool.name === 'Bash')).toBe(true);
    });

    // B-745: a relative icon href resolves to /s/favicon.png on a share page (404).
    it('index.html icon links are root-absolute', () => {
        const html = readFileSync(new URL('../../../index.html', import.meta.url), 'utf8');
        for (const rel of ['icon', 'apple-touch-icon']) expect(html).toMatch(new RegExp(`<link rel="${rel}"[^>]*href="/[^/]`));
    });

    // B-758: `.cl-scroll` contains its overscroll; in a content-tall shell it never overflows, and real
    // Chrome latched wheel/touch onto it with nowhere to go (document scrollTop stayed 0). The shell must be
    // viewport-tall so `.cl-scroll` is the scroller (measured: wheel → .cl-scroll 4200, scrollbar 10px).
    it('the page is a viewport-tall shell and the transcript is the scroller', () => {
        const css = readFileSync(new URL('./sharedLink.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
        const shell = css.match(/\.slk \{([^}]*)\}/)?.[1] ?? '';
        expect(shell).toMatch(/(^|[\s;])height: var\(--app-h\)/);
        expect(shell).not.toMatch(/min-height/);
        expect(css).toMatch(/\.slk-chat \{[^}]*flex: 1;[^}]*min-height: 0/);
        const chat = readFileSync(new URL('../session/chatlist.css', import.meta.url), 'utf8');
        expect(chat).toMatch(/\.cl-scroll \{[^}]*min-height: 0;[^}]*overflow-y: auto/);
        const screen = readFileSync(new URL('./SharedLinkScreen.tsx', import.meta.url), 'utf8');
        expect(screen).toMatch(/<main className="cl slk-chat">\s*<div className="cl-scroll">/);
    });
});
