// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';

/** B-714: the new-task / task-action / handoff forms read FormData — the pickers that replaced their <select>s must still post the same names. */
vi.mock('@/sync/teams', () => ({ actOnTeam: vi.fn(), createTeam: vi.fn(), getTeam: vi.fn(), listTeams: vi.fn(), TeamsApiError: class extends Error {} }));
vi.mock('@/sync/storage', () => ({ storage: () => null, useAllMachines: () => [] }));
vi.mock('@/sync/sync', () => ({ sync: {} }));
vi.mock('@/screens/session/Markdown', () => ({ Markdown: () => null }));
vi.mock('./TeamStartForm', () => ({ TeamStartForm: () => null }));
vi.mock('./TeamWorkspace', () => ({ TeamWorkspace: () => null, TeamListCard: () => null }));
vi.mock('./TeamSchedules', () => ({ TeamSchedules: () => null }));
vi.mock('./TeamOptions', () => ({ TeamOptions: () => null }));
vi.mock('./TeamTaskDetail', () => ({ TeamTaskMessages: () => null, TeamTaskSummary: () => null }));
vi.mock('./AdoptTeamForm', () => ({ AdoptTeamForm: () => null }));
const { DelegateChoices, TaskActionField, HandoffAssignee } = await import('./TeamsScreen');

const bots = [{ id: 'lead', name: 'Lead' }, { id: 'w1', name: 'Worker one' }, { id: 'w2', name: 'Worker two' }];
const team = {
    id: 't', defaults: { assistant: 'codex' }, bots,
    tasks: [
        { id: 'open', goal: 'Ship the parser\nwith tests', status: 'running' },
        { id: 'closed', goal: 'Old work', status: 'done' },
    ],
} as never;

it('every picker in the Teams FormData forms still lands under its old name', async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
    const read = () => Object.fromEntries(new FormData(host.querySelector('form')!) as unknown as Iterable<[string, string]>);
    try {
        await act(async () => root.render(<form><DelegateChoices team={team} agentLabel="Agent" /><TaskActionField canReturn /><HandoffAssignee bots={bots.slice(1) as never} /></form>));
        expect(read()).toEqual({ assistant: 'codex', parent: '', action: 'message', assignee: 'w1' });
        const pressed = (label: string) => [...host.querySelectorAll('button')].find((b) => b.textContent === label)!;
        await act(async () => { pressed('pi').click(); pressed('Return for changes').click(); });
        const parentTrigger = host.querySelector('input[name=parent]')!.parentElement!.querySelector('.vh-select-trigger')!;
        await act(async () => { parentTrigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })); });
        const options = [...document.querySelectorAll<HTMLElement>('[role=option]')];
        expect(options.map((o) => o.title)).toEqual(['Independent task', 'Ship the parser']);
        expect(options[1].textContent).toContain('with tests');
        await act(async () => { options[1].click(); });
        expect(read()).toEqual({ assistant: 'pi-acp', parent: 'open', action: 'return', assignee: 'w1' });
        // the handoff picker is required: its proxy input carries the constraint
        expect(host.querySelector<HTMLInputElement>('input[required]')?.value).toBe('w1');
    } finally { await act(async () => root.unmount()); host.remove(); }
});
