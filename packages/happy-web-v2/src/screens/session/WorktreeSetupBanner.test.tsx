// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
    session: null as any, machine: null as any,
    status: vi.fn(), approve: vi.fn(), decline: vi.fn(), log: vi.fn(),
}));
vi.mock('@/sync/storage', () => ({
    useSession: () => mock.session,
    storage: (selector: any) => selector({ machines: mock.machine ? { m1: mock.machine } : {} }),
}));
vi.mock('@/sync/worktreeOps', () => ({
    worktreeSetupStatus: mock.status, worktreeSetupApprove: mock.approve, worktreeSetupDecline: mock.decline, worktreeSetupLog: mock.log,
}));
vi.mock('@/i18n/useTranslation', () => ({ useTranslation: () => ({ t: (k: string) => k, lang: 'en' }) }));
import { WorktreeSetupBanner } from './WorktreeSetupBanner';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root;
const flush = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };

const pending = (hash: string, script: string, changed = false) => ({
    ok: true,
    data: {
        tracked: true, worktreePath: '/wt', origin: 'web', branch: 'vh/a', repoRoot: '/r', copied: ['.env'], linked: [], skipped: [],
        setup: { state: 'needs-approval', hash },
        pending: { script, hash, runner: 'posix-sh', runnerLabel: '/bin/sh -e setup.sh', cwd: '/wt', repoRoot: '/r', configPath: '/r/.veryhappy/worktree.json', timeoutMinutes: 10, changedSinceApproval: changed },
    },
});

beforeEach(() => {
    host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
    mock.session = { id: 's1', metadata: { machineId: 'm1', path: '/wt', worktree: { branch: 'vh/a', root: '/wt' } } };
    mock.machine = { active: true, metadata: { worktreeVersion: 1 } };
    for (const fn of [mock.status, mock.approve, mock.decline, mock.log]) fn.mockReset();
    mock.log.mockResolvedValue({ ok: true, data: { text: 'done\n', offset: 5, size: 5, done: true } });
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

const click = (text: string) => {
    const button = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes(text));
    if (!button) throw new Error(`no button ${text}`);
    act(() => { button.click(); });
};

describe('B-585 worktree setup banner', () => {
    it('renders nothing for an old daemon or a non-worktree session (no RPC)', async () => {
        mock.machine = { active: true, metadata: {} };
        act(() => root.render(<WorktreeSetupBanner sessionId="s1" />));
        await flush();
        expect(host.textContent).toBe('');
        expect(mock.status).not.toHaveBeenCalled();
    });

    it('needs approval → shows the full script, cwd and runner; approve sends the hash it showed', async () => {
        mock.status.mockResolvedValue(pending('h1', 'pnpm install\nmake dev'));
        mock.approve.mockResolvedValue({ ok: true, data: { ...pending('h1', '').data, setup: { state: 'running' }, pending: undefined } });
        act(() => root.render(<WorktreeSetupBanner sessionId="s1" />));
        await flush();
        expect(host.textContent).toContain('Setup not run');
        click('Review and allow');
        expect(host.querySelector('[data-testid=worktree-setup-script]')?.textContent).toBe('pnpm install\nmake dev');
        expect(host.textContent).toContain('/bin/sh -e setup.sh');
        expect(host.textContent).toContain('/wt');
        click('Allow and run');
        await flush();
        expect(mock.approve).toHaveBeenCalledWith('m1', '/wt', 'h1');
    });

    it('script changed while reviewing → refreshed content, asks again, never auto-runs', async () => {
        mock.status.mockResolvedValueOnce(pending('h1', 'echo old')).mockResolvedValue(pending('h2', 'echo new', true));
        mock.approve.mockResolvedValue({ ok: false, error: 'script-changed', unsupported: false });
        act(() => root.render(<WorktreeSetupBanner sessionId="s1" />));
        await flush();
        click('Review and allow');
        click('Allow and run');
        await flush();
        expect(host.querySelector('[data-testid=worktree-setup-script]')?.textContent).toBe('echo new');
        expect(host.textContent).toContain('changed while you were reviewing');
        expect(host.textContent).toContain('changed since you last allowed it');
        expect(mock.approve).toHaveBeenCalledTimes(1);
    });

    it('decline records the choice and closes', async () => {
        mock.status.mockResolvedValue(pending('h1', 'echo x'));
        mock.decline.mockResolvedValue({ ok: true, data: { ...pending('h1', 'echo x').data, setup: { state: 'declined' } } });
        act(() => root.render(<WorktreeSetupBanner sessionId="s1" />));
        await flush();
        click('Review and allow');
        click('Don’t run');
        await flush();
        expect(mock.decline).toHaveBeenCalledWith('m1', '/wt');
        expect(host.querySelector('[role=dialog]')).toBeNull();
        expect(host.textContent).toContain('Setup skipped');
    });
});
