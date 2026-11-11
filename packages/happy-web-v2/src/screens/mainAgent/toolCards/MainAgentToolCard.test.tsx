// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { MAIN_AGENT_TOOL_FIXTURES } from './mainAgentToolFixtures';
import { mainAgentToolView } from './mainAgentToolView';

let MainAgentToolCard: typeof import('./MainAgentToolCard').MainAgentToolCard;
let linkHref: typeof import('./MainAgentToolCard').linkHref;
beforeAll(async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    ({ MainAgentToolCard, linkHref } = await import('./MainAgentToolCard'));
});

let host: HTMLDivElement | null = null;
let root: Root | null = null;
afterEach(async () => {
    if (root) await act(async () => root!.unmount());
    host?.remove();
    host = null; root = null;
});

function Where() { const l = useLocation(); return <div data-where={`${l.pathname}${l.search}`} />; }

async function renderCard(id: string) {
    const fixture = MAIN_AGENT_TOOL_FIXTURES.find((f) => f.id === id)!;
    const view = mainAgentToolView(fixture.tool)!;
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root!.render(
        <MemoryRouter initialEntries={['/']}>
            <Routes><Route path="*" element={<><MainAgentToolCard view={view} mainAgentSessionId="ma-1" /><Where /></>} /></Routes>
        </MemoryRouter>,
    ));
    return host;
}

describe('MainAgentToolCard (B-923)', () => {
    it('renders every fixture with a status pill and the raw data folded away', async () => {
        for (const f of MAIN_AGENT_TOOL_FIXTURES) {
            const el = await renderCard(f.id);
            const card = el.querySelector('.ma-tc')!;
            expect(card, f.id).not.toBeNull();
            expect(card.querySelector('.ma-tc-pill')?.textContent, f.id).toBeTruthy();
            const raw = card.querySelector('details.ma-tc-raw')!;
            expect(raw.hasAttribute('open')).toBe(false);
            expect(raw.querySelector('pre')?.textContent).toBeTruthy();
            await act(async () => root!.unmount());
            host!.remove(); root = null; host = null;
        }
    });

    it('delegate: team heading, acceptance list, link opens the Lead session', async () => {
        const el = await renderCard('lead_delegate-ok');
        expect(el.querySelector('.ma-tc-heading')?.textContent).toBe('Docs crew');
        expect(el.querySelectorAll('.ma-tc-items li')).toHaveLength(3);
        const link = el.querySelector<HTMLButtonElement>('.ma-tc-link')!;
        await act(async () => link.click());
        expect(el.querySelector('[data-where]')?.getAttribute('data-where')).toBe('/session/sess-lead-1234');
    });

    it('decision card links to the main agent\'s board; blocked links to settings with an alert', async () => {
        let el = await renderCard('session_send-awaiting');
        expect(el.querySelector('.ma-tc')?.getAttribute('data-status')).toBe('awaiting');
        await act(async () => el.querySelector<HTMLButtonElement>('.ma-tc-link')!.click());
        expect(el.querySelector('[data-where]')?.getAttribute('data-where')).toBe('/session/ma-1?panel=board');
        await act(async () => root!.unmount()); host!.remove(); root = null;
        el = await renderCard('blocked-third-party');
        expect(el.querySelector('[role="alert"]')?.textContent).toBeTruthy();
        await act(async () => el.querySelector<HTMLButtonElement>('.ma-tc-link')!.click());
        expect(el.querySelector('[data-where]')?.getAttribute('data-where')).toBe('/settings/main-agent');
    });

    it('board links need the main agent session id', () => {
        expect(linkHref({ kind: 'board' }, null)).toBeNull();
        expect(linkHref({ kind: 'issue', ref: 'vh-3' }, null)).toBe('/issues/VH-3');
    });
});
