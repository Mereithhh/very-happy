// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
const machine = { id: 'm', active: true, metadata: { host: 'computer', cliAvailability: { codex: true, pi: true } } };
vi.mock('@/sync/storage', () => ({ useMachine: () => machine, useAllSessions: () => [{ updatedAt: 1, metadata: { flavor: 'acp', models: [{ code: 'gw/m1', value: 'm1' }] } }] }));
vi.mock('@/i18n/useTranslation', () => ({ useTranslation: () => ({ lang: 'en', t: (key: string) => key }) }));
import { TeamOptions } from './TeamOptions';

it('B-698: team settings show the saved harness/model, flag a model outside the list, and save the pickers', async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
    const save = vi.fn().mockResolvedValue(undefined);
    const team = { id: 't', machineId: 'm', defaults: { assistant: 'codex', model: 'retired-model', maxParallel: 4 } } as never;
    try {
        await act(async () => root.render(<TeamOptions team={team} disabled={false} onSave={save} />));
        const assistant = host.querySelector('input[name=assistant]') as HTMLInputElement;
        const harnessButtons = () => [...assistant.parentElement!.querySelectorAll('button')];
        const model = () => host.querySelector('input[name=model]') as HTMLInputElement;
        const modelTrigger = () => model().parentElement!.querySelector('.vh-select-trigger') as HTMLButtonElement;
        expect(harnessButtons().map((b) => b.textContent)).toEqual(['Claude Code', 'Codex', 'pi']);
        expect(assistant.value).toBe('codex');
        expect(harnessButtons()[1].getAttribute('aria-pressed')).toBe('true');
        expect(model().value).toBe('retired-model');
        expect(modelTrigger().textContent).toContain('retired-model');
        expect(host.textContent).toContain('not in this harness’s list');
        await act(async () => { harnessButtons()[2].click(); });
        expect(model().value).toBe('');
        await act(async () => { modelTrigger().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })); });
        const options = [...document.querySelectorAll<HTMLElement>('[role=option]')];
        expect(options.map((o) => o.title)).toEqual(['Follow the harness default', 'm1 · gw/m1']);
        await act(async () => { options[1].click(); });
        expect(model().value).toBe('gw/m1');
        await act(async () => { host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
        expect(save).toHaveBeenCalledWith({ assistant: 'pi-acp', model: 'gw/m1', maxParallel: 4 });
    } finally { await act(async () => root.unmount()); host.remove(); }
});
