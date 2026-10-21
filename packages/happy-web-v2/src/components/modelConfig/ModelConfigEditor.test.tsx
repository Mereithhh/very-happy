// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const machines = [
    { id: 'machine-a', active: true, metadata: { displayName: 'Alpha', modelConfigVersion: 1 } },
    { id: 'machine-b', active: false, metadata: { displayName: 'Bravo', modelConfigVersion: 1 } },
];
const view = (harness: string) => ({
    harness, installed: true, files: [{ role: 'settings', path: '~/.claude/settings.json', exists: true }], baseHash: 'h',
    current: { authHeader: 'bearer', providerId: harness === 'codex' ? 'p1' : null, activeProvider: 'p1' },
    providers: harness === 'codex' ? ['p1', 'p2'] : undefined,
    pickerModels: [], backups: [{ id: 'b1', createdAt: 0, reason: 'before-apply', files: [] }], warnings: [],
});

vi.mock('@/sync/storage', () => ({ useAllMachines: () => machines }));
vi.mock('@/sync/modelConfigStore', () => ({
    useMachineModelConfig: () => ({ status: 'ready', data: { version: 1, harnesses: ['claude', 'codex', 'gemini', 'pi'].map(view) } }),
    modelConfigStore: { getState: () => ({ load: vi.fn(async () => undefined), setHarnessView: vi.fn() }) },
}));
vi.mock('@/sync/modelConfigOps', () => ({
    modelConfigApply: vi.fn(), modelConfigRead: vi.fn(async () => ({ ok: false })), modelConfigRestore: vi.fn(),
}));

import { ModelConfigEditor } from './ModelConfigEditor';

let host: HTMLDivElement;
let root: Root;
const onOpenChange = vi.fn();

beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    onOpenChange.mockReset();
    act(() => root.render(<MemoryRouter><ModelConfigEditor open onOpenChange={onOpenChange} machineId="machine-a" harness="claude" /></MemoryRouter>));
});

afterEach(() => { act(() => root.unmount()); host.remove(); });

const pickers = () => [...document.querySelectorAll<HTMLButtonElement>('.mce-dialog [role="combobox"]')];
const picker = (name: string) => pickers().find((el) => el.getAttribute('aria-label') === name)!;
const armOutsideListeners = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });

describe('ModelConfigEditor pickers (B-714)', () => {
    it('has no native select, checkbox or summary; machine shows offline as meta', () => {
        expect(document.querySelector('.mce-dialog select, .mce-dialog option')).toBeNull();
        expect(document.querySelector('.mce-dialog summary:not(.vh-summary)')).toBeNull();
        expect(picker('Machine').textContent).toContain('Alpha');
        expect(picker('Auth header').textContent).toContain('Authorization: Bearer');
    });

    it('choosing inside the portaled picker keeps the modal dialog open', async () => {
        act(() => picker('Machine').click());
        await armOutsideListeners();
        const bravo = [...document.querySelectorAll<HTMLElement>('[data-vh-picker-surface] [role="option"]')].find((el) => el.textContent?.includes('Bravo'))!;
        expect(bravo.textContent).toContain('offline');
        // the modal sets body pointer-events:none; the picker layer re-enables itself
        expect(document.body.style.pointerEvents).toBe('none');
        expect(bravo.closest<HTMLElement>('[data-vh-picker-surface]')!.style.pointerEvents).toBe('auto');
        act(() => {
            bravo.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
            bravo.click();
        });
        expect(onOpenChange).not.toHaveBeenCalled();
        expect(document.querySelector('.mce-dialog')).not.toBeNull();
        expect(picker('Machine').textContent).toContain('Bravo');
        // control: a press really outside still dismisses the dialog
        act(() => { document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true })); });
        expect(onOpenChange).toHaveBeenCalledWith(false);
    });

    it('Escape closes only the picker', async () => {
        act(() => picker('Auth header').click());
        await armOutsideListeners();
        expect(document.querySelector('[data-vh-picker-surface]')).not.toBeNull();
        act(() => { document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });
        expect(document.querySelector('[data-vh-picker-surface]')).toBeNull();
        expect(onOpenChange).not.toHaveBeenCalled();
        expect(document.querySelector('.mce-dialog')).not.toBeNull();
    });

    it('codex: provider picker lists providers + new provider, activate is a Checkbox', () => {
        const codex = [...document.querySelectorAll<HTMLButtonElement>('.mce-harness button')].find((el) => el.textContent === 'Codex')!;
        act(() => codex.click());
        expect(picker('Provider').textContent).toContain('p1');
        const activate = document.querySelector<HTMLInputElement>('.mce-check input[type="checkbox"]')!;
        expect(activate.closest('.vh-checkbox')).not.toBeNull();
        expect(activate.checked).toBe(false);
        act(() => activate.click());
        expect(activate.checked).toBe(true);
    });
});
