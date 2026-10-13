// @vitest-environment happy-dom
/**
 * B-563: the dock above the composer — fold, auto-expand on a new request,
 * rows unmount with their request, decided requests never linger, pointer opens.
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ session: null as any, listeners: new Set<() => void>() }));
vi.mock('@/sync/storage', async () => {
    const { useSyncExternalStore } = await import('react');
    return {
        useSession: () => useSyncExternalStore(
            (l: () => void) => { state.listeners.add(l); return () => state.listeners.delete(l); },
            () => state.session,
        ),
    };
});
vi.mock('@/sync/ops', () => ({ sessionAllow: vi.fn(async () => {}), sessionDeny: vi.fn(async () => {}) }));
vi.mock('@/i18n/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/ui', () => ({
    Button: ({ children, onClick, disabled }: { children: React.ReactNode; onClick?: () => void; disabled?: boolean }) => (
        <button type="button" data-btn disabled={disabled} onClick={onClick}>{children}</button>
    ),
}));
vi.mock('./CodeView', () => ({ CodeView: ({ code }: { code: string }) => <pre>{code}</pre> }));
vi.mock('./Markdown', () => ({ Markdown: ({ text }: { text: string }) => <div>{text}</div> }));
vi.mock('./ElicitationRequestView', () => ({ ElicitationRequestView: () => null }));
import { PermissionCard, PermissionPointer } from './PermissionCard';
import { expandPermissionDock } from './permissionDock';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function setSession(requests: Record<string, unknown>, extra: Record<string, unknown> = {}) {
    state.session = {
        id: 's', metadata: { flavor: 'claude' }, permissionMode: 'default',
        agentState: { controlledByUser: false, requests, ...extra },
    };
    act(() => state.listeners.forEach((l) => l()));
}
const bash = (id: string, command = 'ls') => ({ [id]: { tool: 'Bash', arguments: { command }, createdAt: 1 } });

let root: ReturnType<typeof createRoot> | null = null;
let host: HTMLElement;
beforeEach(() => {
    expandPermissionDock('s');
    host = document.createElement('div');
    document.body.appendChild(host);
});
afterEach(() => { act(() => root?.unmount()); root = null; document.body.innerHTML = ''; });
function mount() {
    root = createRoot(host);
    act(() => root!.render(<><div className="cl-inner"><PermissionPointer sessionId="s" /></div><PermissionCard sessionId="s" /></>));
}
const body = () => host.querySelector<HTMLElement>('.perm-dock-body');
const head = () => host.querySelector<HTMLButtonElement>('.perm-card-head')!;

describe('B-563 PermissionCard dock', () => {
    it('folds to one summary line and unfolds', () => {
        setSession(bash('a', 'git push'));
        mount();
        expect(body()?.hidden).toBe(false);
        act(() => head().click());
        expect(body()?.hidden).toBe(true);
        expect(head().getAttribute('aria-expanded')).toBe('false');
        expect(host.querySelector('.perm-summary')?.textContent).toBe('Bash · git push');
        act(() => head().click());
        expect(body()?.hidden).toBe(false);
    });

    it('a new request re-opens a folded dock; answering one keeps it folded', () => {
        setSession({ ...bash('a'), ...bash('b') });
        mount();
        act(() => head().click());
        setSession(bash('b'));
        expect(body()?.hidden).toBe(true);
        setSession({ ...bash('b'), ...bash('c') });
        expect(body()?.hidden).toBe(false);
    });

    it('rows unmount with their request; the dock disappears when none are left', () => {
        setSession({ ...bash('a', 'one'), ...bash('b', 'two') });
        mount();
        expect(host.querySelectorAll('.perm-req')).toHaveLength(2);
        setSession(bash('b', 'two'));
        expect(host.querySelectorAll('.perm-req')).toHaveLength(1);
        expect(host.textContent).not.toContain('one');
        setSession({});
        expect(host.querySelector('.perm-dock')).toBeNull();
        expect(host.querySelector('.perm-pointer')).toBeNull();
    });

    it('a request already in completedRequests is never offered again', () => {
        setSession({ ...bash('a', 'done-cmd'), ...bash('b', 'live-cmd') }, { completedRequests: { a: { tool: 'Bash', status: 'approved' } } });
        mount();
        expect(host.querySelectorAll('.perm-req')).toHaveLength(1);
        expect(host.textContent).not.toContain('done-cmd');
    });

    it('the transcript pointer opens a folded dock and focuses its head', () => {
        setSession(bash('a'));
        mount();
        act(() => head().click());
        const raf = vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb) => { cb(0); return 0; });
        act(() => host.querySelector<HTMLButtonElement>('.perm-pointer-action')!.click());
        raf.mockRestore();
        expect(body()?.hidden).toBe(false);
        expect(document.activeElement).toBe(head());
    });

    it('a terminal mirror renders neither dock nor pointer (B-105)', () => {
        setSession(bash('a'));
        state.session.metadata = { flavor: 'terminal-mirror' };
        mount();
        expect(host.querySelector('.perm-dock')).toBeNull();
        expect(host.querySelector('.perm-pointer')).toBeNull();
    });
});
