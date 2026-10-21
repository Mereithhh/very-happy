// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/sync/worktreeOps', () => ({ worktreeInfo: vi.fn() }));
import { EMPTY_WORKTREE_DRAFT, NewWorktreeFields, worktreeDraftReady, type WorktreeInfoState } from './NewWorktreeFields';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root;
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

const info: WorktreeInfoState = { phase: 'done', result: { ok: true, data: { repoRoot: '/r', currentBranch: 'main', branches: ['main'], defaultParent: '/r.worktrees', config: { source: 'default', copy: ['.env*'], link: [], hasSetup: true, setupApproved: false } } } };

describe('B-586 new worktree fields', () => {
    it('old daemon: the option is disabled with an upgrade hint', () => {
        act(() => root.render(<NewWorktreeFields lang="en" supported={false} draft={EMPTY_WORKTREE_DRAFT} onChange={() => undefined} info={{ phase: 'idle' }} />));
        expect((host.querySelector('input[type=checkbox]') as HTMLInputElement).disabled).toBe(true);
        expect(host.textContent).toContain('too old for worktrees');
    });

    it('a Method-not-found answer also shows the upgrade hint', () => {
        act(() => root.render(<NewWorktreeFields lang="en" supported draft={{ ...EMPTY_WORKTREE_DRAFT, enabled: true }} onChange={() => undefined} info={{ phase: 'done', result: { ok: false, error: 'Method not found', unsupported: true } }} />));
        expect(host.textContent).toContain('too old for worktrees');
        expect((host.querySelector('input[type=checkbox]') as HTMLInputElement).checked).toBe(false);
    });

    it('summarizes copy and setup trust', () => {
        act(() => root.render(<NewWorktreeFields lang="zh-Hans" supported draft={{ enabled: true, baseRef: 'main', branch: 'vh/a', location: '/r.worktrees/vh-a', locationEdited: false }} onChange={() => undefined} info={info} />));
        expect(host.textContent).toContain('复制 .env*');
        expect(host.textContent).toContain('setup：需要你确认后才会运行');
    });

    it('adopts defaults once: current branch, generated name, location beside the repo', () => {
        const onChange = vi.fn();
        act(() => root.render(<NewWorktreeFields lang="en" supported draft={{ ...EMPTY_WORKTREE_DRAFT, enabled: true }} onChange={onChange} info={info} />));
        const next = onChange.mock.calls[0][0];
        expect(next.baseRef).toBe('main');
        expect(next.branch).toMatch(/^vh\/[a-z]+-[a-z]+$/);
        expect(next.location).toBe(`/r.worktrees/${next.branch.replace('/', '-')}`);
    });

    it('base branch is a searchable picker (B-714): typing filters, Enter picks', () => {
        const many: WorktreeInfoState = { phase: 'done', result: { ok: true, data: { ...(info as any).result.data, branches: ['main', 'dev', 'feat/x'] } } };
        const onChange = vi.fn();
        const draft = { enabled: true, baseRef: 'main', branch: 'vh/a', location: '/r.worktrees/vh-a', locationEdited: false };
        act(() => root.render(<NewWorktreeFields lang="en" supported draft={draft} onChange={onChange} info={many} />));
        onChange.mockClear();
        expect(host.querySelector('select')).toBeNull();
        const trigger = host.querySelector<HTMLButtonElement>('#nwt-base')!;
        expect(trigger.getAttribute('role')).toBe('combobox');
        expect(trigger.getAttribute('aria-labelledby')).toBe('nwt-base-label');
        act(() => { trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })); });
        const search = document.querySelector<HTMLInputElement>('.vh-picker-search')!;
        expect(search).not.toBeNull();
        act(() => {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'feat');
            search.dispatchEvent(new Event('input', { bubbles: true }));
        });
        expect([...document.querySelectorAll('[role="option"]')].map((o) => o.textContent)).toEqual(['feat/x']);
        act(() => { search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); });
        expect(onChange).toHaveBeenCalledWith({ ...draft, baseRef: 'feat/x' });
    });

    it('ready only with info + valid fields', () => {
        const draft = { enabled: true, baseRef: 'main', branch: 'vh/a', location: '/r.worktrees/vh-a', locationEdited: false };
        expect(worktreeDraftReady(draft, info)).toBe(true);
        expect(worktreeDraftReady({ ...draft, branch: 'a..b' }, info)).toBe(false);
        expect(worktreeDraftReady({ ...draft, location: 'rel' }, info)).toBe(false);
        expect(worktreeDraftReady(draft, { phase: 'loading' })).toBe(false);
        expect(worktreeDraftReady({ ...draft, enabled: false }, { phase: 'idle' })).toBe(true);
    });
});
