// @vitest-environment happy-dom
/**
 * B-873b (spec 2026-11-issues §10 会话头): a session an issue run started shows
 * 「VH-N · 状态」 and a click opens the issue; switch off shows nothing and asks
 * nothing; the phone header gets the same entry as a ⋯ row.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/auth/AuthContext', () => ({ getCurrentAuth: () => ({ credentials: { token: 't' } }) }));
vi.mock('@/sync/serverConfig', () => ({ getServerUrl: () => 'https://test.invalid' }));
vi.mock('@/sync/apiSocket', () => ({ getHappyClientId: () => 'test' }));
const i18n = vi.hoisted(() => ({ lang: 'en' }));
vi.mock('@/i18n/useTranslation', () => ({ useTranslation: () => ({ lang: i18n.lang, t: (key: string) => key }) }));
const sessions = vi.hoisted(() => ({ metadata: {} as Record<string, unknown> }));
vi.mock('@/sync/storage', () => ({ useSession: () => ({ id: 'sess', metadata: sessions.metadata }), useAllMachines: () => [] }));

import { setIssuesTransport } from '@/sync/apiIssues';
import { createFakeIssuesServer, type FakeIssuesServer } from '@/sync/issuesFake';
import { _forTests, applyIssueRunUpdate, applyIssueUpdate, createIssue, probeIssues } from '@/sync/issuesStore';
import type { MenuItemDef } from '@/ui';
import { SessionIssueChip, useSessionIssue, useSessionIssueMenuItem } from './SessionIssueChip';

const codex = { kind: 'agent', machineId: 'm1', agent: 'codex' } as const;
let host: HTMLDivElement;
let root: Root;
let menuItem: MenuItemDef | null = null;

function Header({ phone }: { phone: boolean }) {
    const issue = useSessionIssue('sess')?.issue ?? null;
    menuItem = useSessionIssueMenuItem(phone ? issue : null);
    return issue && !phone ? <SessionIssueChip issue={issue} /> : null;
}
function Where() { const l = useLocation(); return <div data-testid="where">{l.pathname}</div>; }
async function render(phone = false) {
    await act(async () => {
        root.render(<MemoryRouter initialEntries={['/session/sess']}><Routes>
            <Route path="/session/:id" element={<Header phone={phone} />} />
            <Route path="/issues/:key" element={<Where />} />
        </Routes></MemoryRouter>);
    });
    for (let i = 0; i < 5; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}
async function seed(server: FakeIssuesServer) {
    server.subscribe((u) => { if (u.t === 'issue') applyIssueUpdate(u.issue); else if (u.t === 'issue-run') applyIssueRunUpdate(u.run); });
    await probeIssues();
    const issue = await createIssue({ title: 'Fix login', assignee: codex });
    server.agent.start(server.runs()[0].id, 'sess');
    return issue;
}
const chip = () => host.querySelector<HTMLButtonElement>('[data-testid="session-issue-chip"]');

beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    _forTests.reset();
    i18n.lang = 'en';
    sessions.metadata = {};
    menuItem = null;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); setIssuesTransport(null); _forTests.reset(); });

describe('B-873b session header VH-N chip', () => {
    it('shows 「VH-N · status」 from the run table; a click opens the issue', async () => {
        const server = createFakeIssuesServer();
        setIssuesTransport(server.transport);
        const issue = await seed(server);
        await render();
        expect(chip()?.textContent).toBe(`${issue.key} · In progress`);
        expect(chip()?.getAttribute('aria-label')).toContain('Fix login');
        await act(async () => { chip()!.click(); });
        expect(host.querySelector('[data-testid="where"]')?.textContent).toBe(`/issues/${issue.key}`);
    });
    it('follows the issue status live and reads in Chinese', async () => {
        i18n.lang = 'zh-Hans';
        const server = createFakeIssuesServer();
        setIssuesTransport(server.transport);
        const issue = await seed(server);
        await render();
        expect(chip()?.textContent).toBe(`${issue.key} · 进行中`);
        await act(async () => { server.agent.setStatus(server.runs()[0].id, 'in_review', 'delivered'); });
        expect(chip()?.textContent).toBe(`${issue.key} · 待验收`);
        expect(chip()?.getAttribute('title')).toBe(`本会话在做 ${issue.key}「Fix login」，点击打开 issue`);
    });
    it('a session missing from the store is looked up once when it may belong to an issue', async () => {
        const server = createFakeIssuesServer();
        setIssuesTransport(server.transport);
        const issue = await seed(server);
        _forTests.reset();
        const calls: string[] = [];
        setIssuesTransport(async (m, p, b) => { calls.push(`${m} ${p.split('?')[0]}`); return server.transport(m, p, b); });
        sessions.metadata = { capabilities: ['issue-v1'] };
        await render();
        expect(calls).toEqual(['GET ', 'GET /session/sess']);
        expect(chip()?.textContent).toBe(`${issue.key} · In progress`);
    });
    it('an ordinary session (no metadata.issue, no issue-v1) asks nothing and shows nothing', async () => {
        const server = createFakeIssuesServer();
        const calls: string[] = [];
        setIssuesTransport(async (m, p, b) => { calls.push(`${m} ${p.split('?')[0]}`); return server.transport(m, p, b); });
        await render();
        expect(calls).toEqual(['GET ']);
        expect(chip()).toBeNull();
    });
    it('switch off: no chip, no lookup — even for a session that says it belongs to an issue', async () => {
        const server = createFakeIssuesServer({ enabled: false });
        const calls: string[] = [];
        setIssuesTransport(async (m, p, b) => { calls.push(`${m} ${p.split('?')[0]}`); return server.transport(m, p, b); });
        sessions.metadata = { issue: { id: 'i1', key: 'VH-1' }, capabilities: ['issue-v1'] };
        await render();
        expect(chip()).toBeNull();
        expect(calls).toEqual(['GET ']);
    });
    it('phone: the same entry as a ⋯ row instead of a bar chip', async () => {
        const server = createFakeIssuesServer();
        setIssuesTransport(server.transport);
        const issue = await seed(server);
        await render(true);
        expect(chip()).toBeNull();
        expect(menuItem?.label).toBe(`${issue.key} · In progress`);
        await act(async () => { menuItem!.onSelect?.(); });
        expect(host.querySelector('[data-testid="where"]')?.textContent).toBe(`/issues/${issue.key}`);
    });
    it('touch: the chip is a 44px target under pointer: coarse', () => {
        const css = readFileSync(resolve(__dirname, 'issues.css'), 'utf8');
        const coarse = css.slice(css.indexOf('@media (pointer: coarse)'));
        expect(coarse).toMatch(/\.is-session-chip\s*\{\s*height:\s*44px;/);
    });
});
