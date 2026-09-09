// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ presets: [{ id: 'p1', title: 'Review', text: 'Review the changes', run: true }], pick: vi.fn() }));
vi.mock('@/sync/storage', () => ({ useSettings: () => ({ promptPresets: mocks.presets }) }));
vi.mock('@/i18n/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
import { PresetsMenu } from './PresetsMenu';
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    mocks.presets = [{ id: 'p1', title: 'Review', text: 'Review the changes', run: true }]; mocks.pick.mockClear();
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });
async function render() { await act(async () => root.render(<PresetsMenu onPick={mocks.pick} onAttach={() => {}} />)); }
async function menuClick(text: string) {
    const item = [...document.querySelectorAll<HTMLElement>('[role=menuitem]')].find(el => el.textContent?.includes(text));
    expect(item).toBeDefined(); await act(async () => item!.click());
}
async function chord() { await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Period', key: '.', ctrlKey: true, bubbles: true }))); }
describe('composer plus menu', () => {
    it('opens shortcuts as one option in the same panel, then inserts without sending', async () => {
        await render();
        await act(async () => host.querySelector('button')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
        expect(document.querySelector('[role=menu]')?.textContent).toContain('session.chat.presets');
        expect(document.querySelector('[role=menu]')?.textContent).not.toContain('Review the changes');
        await menuClick('session.chat.presets');
        expect(document.querySelectorAll('[role=menu]')).toHaveLength(1);
        expect(document.querySelector('[role=menu]')?.textContent).toContain('Review the changes');
        await menuClick('common.back');
        expect(document.querySelector('[role=menu]')?.textContent).not.toContain('Review the changes');
        await menuClick('session.chat.presets'); await menuClick('Review');
        expect(mocks.pick).toHaveBeenCalledExactlyOnceWith('Review the changes');
        expect(document.querySelector('[role=menu]')).toBeNull();
    });
    it('preserves the direct shortcut chord and digit selection', async () => {
        await render(); await chord();
        expect(document.querySelector('[role=menu]')?.textContent).toContain('Review the changes');
        await act(async () => document.querySelector('[role=menu]')!.dispatchEvent(new KeyboardEvent('keydown', { key: '1', bubbles: true })));
        expect(mocks.pick).toHaveBeenCalledExactlyOnceWith('Review the changes');
    });
    it('lets the advertised chord open attachment tools when no shortcuts are configured', async () => {
        mocks.presets = []; await render(); await chord();
        expect(document.querySelector('[role=menu]')?.textContent).toContain('session.chat.attach');
        expect(document.querySelector('[role=menu]')?.textContent).not.toContain('session.chat.presets');
    });
});
