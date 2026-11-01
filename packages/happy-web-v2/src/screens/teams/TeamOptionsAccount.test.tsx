// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

const profiles = (features?: string[]) => ({
    daemonPid: 7, updatedAt: 1, defaults: {}, kinds: ['claude-subscription', 'claude-api', 'codex-chatgpt', 'codex-provider'],
    accounts: [{ id: 'org-a', label: 'Org A (live)', agent: 'claude', kind: 'claude-api', status: 'ok' }],
    ...(features ? { features } : {}),
});
let machine: Record<string, unknown> = {};
vi.mock('@/sync/storage', () => ({ useMachine: () => machine, useAllSessions: () => [] }));
vi.mock('@/i18n/useTranslation', () => ({ useTranslation: () => ({ lang: 'en', t: (key: string) => key }) }));
import { TeamOptions } from './TeamOptions';

async function mount(team: unknown) {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
    const save = vi.fn().mockResolvedValue(undefined);
    await act(async () => root.render(<TeamOptions team={team as never} disabled={false} onSave={save} />));
    return { host, save, done: async () => { await act(async () => root.unmount()); host.remove(); } };
}
const baseMachine = (features?: string[]) => ({ id: 'm', active: true, metadata: { host: 'c', cliAvailability: { codex: true, pi: true } }, daemonState: { pid: 7, agentProfiles: profiles(features) } });

describe('B-850e team default account', () => {
    it('shows the live label, keeps the account on save, and a new agent clears it', async () => {
        machine = baseMachine(['launch-accounts']);
        const { host, save, done } = await mount({ id: 't', machineId: 'm', defaults: { assistant: 'claude', maxParallel: 3, agentProfile: { id: 'org-a', label: 'Org A' } } });
        try {
            const field = host.querySelector('[data-testid="team-default-account"]')!;
            expect(field.textContent).toContain('Org A (live)');
            expect(host.querySelector('[data-testid="team-default-account-gate"]')).toBeNull();
            await act(async () => { host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
            expect(save).toHaveBeenLastCalledWith({ assistant: 'claude', maxParallel: 3, agentProfile: { id: 'org-a', label: 'Org A' } });
            const harness = [...(host.querySelector('input[name=assistant]') as HTMLInputElement).parentElement!.querySelectorAll('button')];
            await act(async () => { harness[1].click(); });
            await act(async () => { host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
            expect(save).toHaveBeenLastCalledWith({ assistant: 'codex', maxParallel: 3 });
        } finally { await done(); }
    });

    it('a daemon without launch-accounts: the choice still saves, with the upgrade notice', async () => {
        machine = baseMachine();
        const { host, save, done } = await mount({ id: 't', machineId: 'm', defaults: { assistant: 'claude', maxParallel: 3, agentProfile: null } });
        try {
            expect(host.querySelector('[data-testid="team-default-account-gate"]')?.textContent).toBe('accounts.gateUpgrade');
            await act(async () => { host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
            expect(save).toHaveBeenLastCalledWith({ assistant: 'claude', maxParallel: 3, agentProfile: null });
        } finally { await done(); }
    });

    it('an old CLI (no accounts at all) shows the notice too', async () => {
        machine = { id: 'm', active: true, metadata: { host: 'c' }, daemonState: { pid: 7 } };
        const { host, done } = await mount({ id: 't', machineId: 'm', defaults: { assistant: 'claude', maxParallel: 3 } });
        try {
            expect(host.querySelector('[data-testid="team-default-account-gate"]')).not.toBeNull();
        } finally { await done(); }
    });
});
