// @vitest-environment happy-dom
/**
 * B-730: a conversation that already leads or works in another team is not
 * silently moved. The wrapper refuses (`session_in_other_team`, nothing done);
 * the form asks the owner, and only a confirmed request carries `transfer`.
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const rpc = vi.fn();
vi.mock('@/i18n/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key, lang: 'en' }) }));
vi.mock('@/sync/storage', () => ({
  useProfile: () => ({ id: 'account' }),
  useSession: () => ({ archivedAt: null, metadata: { capabilities: ['teams-adopt-v1'], machineId: 'm', summary: { text: 'Pool' } } }),
}));
vi.mock('@/sync/apiSocket', () => ({ apiSocket: { sessionRPC: (...args: unknown[]) => rpc(...args) } }));
vi.mock('@/sync/serverConfig', () => ({ getServerUrl: () => 'https://server' }));
vi.mock('@/screens/sessions/useTeamNavigation', () => ({ useTeamNavigation: () => [], refreshTeamNavigation: () => {} }));
vi.mock('@/ui/SelectMenu', () => ({ SelectMenu: () => null }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { AdoptTeamForm } = await import('./AdoptTeamForm');
let host: HTMLDivElement;
beforeEach(() => { localStorage.clear(); rpc.mockReset(); host = document.createElement('div'); document.body.append(host); });
afterEach(() => host.remove());
const flush = async () => { for (let i = 0; i < 10; i++) await act(async () => { await Promise.resolve(); }); };
const button = (label: string) => [...host.querySelectorAll('button')].find(b => b.textContent === label)!;

it('asks before moving a conversation out of its team, then retries with transfer', async () => {
  const onDone = vi.fn();
  rpc.mockImplementation(async (_sid: string, _method: string, input: { transfer?: true }) => input.transfer
    ? { status: 'connected', teamId: 'new', botId: 'b', instructions: '' }
    : { error: 'already in team', safeToChange: true, code: 'session_in_other_team', teamId: 'cot', teamName: 'atlas-pay-ops' });
  const root = createRoot(host);
  await act(async () => root.render(<AdoptTeamForm sessionId="s1" onDone={onDone} />));
  await flush();
  await act(async () => { host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
  await flush();
  const dialog = host.querySelector('[role="alertdialog"]')!;
  expect(dialog.textContent).toContain('atlas-pay-ops');
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(rpc).toHaveBeenCalledTimes(1);
  expect(rpc.mock.calls[0][2]).not.toHaveProperty('transfer');
  expect(onDone).not.toHaveBeenCalled();

  await act(async () => button('Cancel').click());
  expect(host.querySelector('[role="alertdialog"]')).toBeNull();
  expect(rpc).toHaveBeenCalledTimes(1);

  await act(async () => { host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
  await flush();
  await act(async () => button('Transfer').click());
  await flush();
  const confirmed = rpc.mock.calls.at(-1)![2];
  expect(confirmed).toMatchObject({ transfer: true, name: 'Pool' });
  expect(confirmed.requestId).not.toBe(rpc.mock.calls[0][2].requestId);
  expect(onDone).toHaveBeenCalledTimes(1);
  act(() => root.unmount());
});
