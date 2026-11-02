// @vitest-environment happy-dom
/**
 * B-873 regression (spec 拍板记录): with `VH_ISSUES_ENABLED` off the Web must
 * look exactly as before — /todos is the old page (no redirect), the 汇报板
 * cards keep their option buttons. With it on, /todos lands on the
 * unassigned-issues view.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/auth/AuthContext', () => ({ getCurrentAuth: () => ({ credentials: { token: 't' } }) }));
vi.mock('@/sync/serverConfig', () => ({ getServerUrl: () => 'https://test.invalid' }));
vi.mock('@/sync/apiSocket', () => ({ getHappyClientId: () => 'test' }));
vi.mock('@/i18n/useTranslation', () => ({ useTranslation: () => ({ lang: 'en', t: (key: string) => key }) }));
vi.mock('@/app/RouteLoading', () => ({ RouteLoading: () => <div data-testid="loading" /> }));
vi.mock('@/screens/todos/TodosScreen', () => ({ TodosScreen: () => <div data-testid="old-todos">Todos</div> }));

import { setIssuesTransport } from '@/sync/apiIssues';
import { createFakeIssuesServer } from '@/sync/issuesFake';
import { _forTests } from '@/sync/issuesStore';
import { TodosGate, TODOS_REDIRECT } from './TodosGate';
import { isIssueReviewItem, issueLinkOf } from '@/screens/session/board/IssueItemActions';

let host: HTMLDivElement;
let root: Root;
function Where() { const l = useLocation(); return <div data-testid="where">{l.pathname + l.search}</div>; }
async function renderAt(path: string) {
    await act(async () => {
        root.render(<MemoryRouter initialEntries={[path]}><Routes><Route path="/todos" element={<TodosGate />} /><Route path="/issues" element={<Where />} /></Routes></MemoryRouter>);
    });
    for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve(); });
}

beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    _forTests.reset();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); setIssuesTransport(null); _forTests.reset(); });

describe('B-873 /todos gate', () => {
    it('switch off: the old Todos page, no redirect', async () => {
        setIssuesTransport(createFakeIssuesServer({ enabled: false }).transport);
        await renderAt('/todos');
        expect(host.querySelector('[data-testid="old-todos"]')).not.toBeNull();
        expect(host.querySelector('[data-testid="where"]')).toBeNull();
    });
    it('older server (unknown route): the old Todos page', async () => {
        setIssuesTransport(async () => ({ status: 404, data: { error: 'Not Found' } }));
        await renderAt('/todos');
        expect(host.querySelector('[data-testid="old-todos"]')).not.toBeNull();
    });
    it('no answer (network): the old Todos page once the probe settles', async () => {
        setIssuesTransport(async () => { throw new Error('offline'); });
        await renderAt('/todos');
        expect(host.querySelector('[data-testid="old-todos"]')).not.toBeNull();
    });
    it('switch on: /todos → /issues?assignee=none', async () => {
        setIssuesTransport(createFakeIssuesServer({ enabled: true }).transport);
        await renderAt('/todos');
        expect(host.querySelector('[data-testid="where"]')?.textContent).toBe(TODOS_REDIRECT);
    });
});

describe('B-873 汇报板 cards', () => {
    it('only bridge items with an issue link get the issue actions; others keep their option buttons', () => {
        expect(isIssueReviewItem({ key: 'decide-1', links: null })).toBe(false);
        expect(isIssueReviewItem({ key: 'issue-review:i1', links: null })).toBe(false);
        expect(isIssueReviewItem({ key: 'issue-review:i1', links: [{ type: 'issue', ref: 'i1', label: 'VH-1' }] })).toBe(true);
        expect(issueLinkOf({ links: [{ type: 'panel', ref: 'x' }] })).toBeNull();
    });
});
