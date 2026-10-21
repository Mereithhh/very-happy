// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
const machine = { id: 'm', active: true, metadata: { host: 'computer', cliAvailability: { codex: true, pi: true } } };
vi.mock('@/sync/storage', () => ({ useMachine: () => machine, useAllSessions: () => [{ updatedAt: 1, metadata: { flavor: 'acp', models: [{ code: 'gw/m1', value: 'm1' }] } }] }));
vi.mock('@/i18n/useTranslation', () => ({ useTranslation: () => ({ lang: 'en', t: (key: string) => key }) }));
import { TeamOptions } from './TeamOptions';

it('B-698: team settings show the saved harness/model, flag a model outside the list, and save the selects', async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
    const save = vi.fn().mockResolvedValue(undefined);
    const team = { id: 't', machineId: 'm', defaults: { assistant: 'codex', model: 'retired-model', maxParallel: 4 } } as never;
    try {
        await act(async () => root.render(<TeamOptions team={team} disabled={false} onSave={save} />));
        const assistant = host.querySelector('select[name=assistant]') as HTMLSelectElement;
        const model = host.querySelector('select[name=model]') as HTMLSelectElement;
        expect([...assistant.options].map((o) => o.value)).toEqual(['claude', 'codex', 'pi-acp']);
        expect(assistant.value).toBe('codex');
        expect(model.value).toBe('retired-model');
        expect(host.textContent).toContain('not in this harness’s list');
        await act(async () => { assistant.value = 'pi-acp'; assistant.dispatchEvent(new Event('change', { bubbles: true })); });
        const piModel = host.querySelector('select[name=model]') as HTMLSelectElement;
        expect([...piModel.options].map((o) => o.value)).toEqual(['', 'gw/m1']);
        await act(async () => { piModel.value = 'gw/m1'; piModel.dispatchEvent(new Event('change', { bubbles: true })); });
        await act(async () => { host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
        expect(save).toHaveBeenCalledWith({ assistant: 'pi-acp', model: 'gw/m1', maxParallel: 4 });
    } finally { await act(async () => root.unmount()); host.remove(); }
});
