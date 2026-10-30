// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelEffortMenu } from './ModelEffortMenu';

const models = [{ key: 'model-a', name: 'Model A' }, { key: 'model-b', name: 'Model B' }];
const levels = ['default', 'low', 'medium', 'xhigh'].map((key) => ({ key, name: key }));
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
});

afterEach(() => { act(() => root.unmount()); host.remove(); });

describe('ModelEffortMenu maximum indicator', () => {
    it('shows shared energy on the actual closed composer entry, with unchanged readable labels', () => {
        act(() => root.render(<ModelEffortMenu label="Model" modelLabel="Model" options={models} value="model-a" onChange={vi.fn()}
            effort={{ label: 'Thinking', options: levels, value: 'xhigh', onChange: vi.fn() }} />));
        const trigger = host.querySelector('button')!;
        expect(trigger.getAttribute('aria-label')).toBe('Model');
        expect(trigger.textContent).toBe('Model Axhigh');
        expect(trigger.querySelector('.me-strength--max .effort-energy')?.getAttribute('aria-hidden')).toBe('true');
        expect(trigger.querySelector('.effort-energy-flow')).not.toBeNull();
        expect(document.querySelector('.me-panel')).toBeNull();
    });

    it('removes energy as the supported range, selected level or selected model changes', () => {
        const render = (value: string | null, supported = levels, model = 'model-a') => act(() => root.render(
            <ModelEffortMenu label="Model" modelLabel="Model" options={models} value={model} onChange={vi.fn()}
                effort={{ label: 'Thinking', options: supported, value, onChange: vi.fn() }} />,
        ));
        render('xhigh');
        expect(host.querySelector('.effort-energy')).not.toBeNull();
        render('xhigh', [...levels, { key: 'ultra', name: 'ultra' }], 'model-b');
        expect(host.querySelector('.effort-energy')).toBeNull();
        for (const value of ['default', 'low', 'medium', 'unknown', null]) {
            render(value);
            expect(host.querySelector('.me-strength--max')).toBeNull();
            expect(host.querySelector('.effort-energy')).toBeNull();
        }
        render('off', [{ key: 'default', name: 'Default' }, { key: 'off', name: 'Off' }]);
        expect(host.querySelector('.effort-energy')).toBeNull();
        render('xhigh', []);
        expect(host.querySelector('.me-strength')).toBeNull();
        expect(host.querySelector('.effort-energy')).toBeNull();
    });

    it('opens ONE flat panel: model rows, more models, 1M switch, named effort stops, footer — no nested picker', () => {
        const onModelChange = vi.fn();
        const onEffortChange = vi.fn();
        const onDefault = vi.fn();
        const layout = { primary: [models[0]], more: [models[1]], longContext: { on: false, onKey: 'model-a[1m]', offKey: 'model-a' }, selectedInMore: false };
        act(() => root.render(<ModelEffortMenu label="Run setup" modelLabel="Model" options={models} layout={layout} value="model-a" onChange={onModelChange}
            longContextLabel="1M context" moreLabel="More models"
            footer={{ note: 'This session only', action: { label: 'Use for new sessions…', onSelect: onDefault } }}
            effort={{ label: 'Thinking', options: levels, value: 'xhigh', onChange: onEffortChange }} />));
        act(() => host.querySelector<HTMLButtonElement>('.me-trigger')!.click());
        const panel = document.querySelector('.me-panel')!;
        expect(panel.querySelector('[role="combobox"]')).toBeNull();
        const radios = () => [...panel.querySelectorAll<HTMLButtonElement>('.me-models [role="radio"]')].map((el) => el.textContent);
        expect(radios()).toEqual(['Model A']);
        act(() => panel.querySelector<HTMLButtonElement>('.me-more')!.click());
        expect(radios()).toEqual(['Model A', 'Model B']);
        act(() => [...panel.querySelectorAll<HTMLButtonElement>('.me-models [role="radio"]')][1].click());
        expect(onModelChange).toHaveBeenLastCalledWith('model-b');
        act(() => panel.querySelector<HTMLButtonElement>('[role="switch"]')!.click());
        expect(onModelChange).toHaveBeenLastCalledWith('model-a[1m]');
        const stops = [...panel.querySelectorAll<HTMLButtonElement>('.effort-seg [role="radio"]')];
        expect(stops.map((el) => el.textContent)).toEqual(['default', 'low', 'medium', 'xhigh']);
        expect(panel.querySelector('.effort-seg-stop--on .effort-energy')).not.toBeNull();
        act(() => stops[1].click());
        expect(onEffortChange).toHaveBeenCalledExactlyOnceWith('low');
        act(() => panel.querySelector<HTMLButtonElement>('.me-footer .me-link')!.click());
        expect(onDefault).toHaveBeenCalledOnce();
        expect(document.querySelector('.me-panel')).toBeNull();
    });

    it('opens with 「更多模型」 expanded when the selected entry lives there', () => {
        const layout = { primary: [models[0]], more: [models[1]], longContext: null, selectedInMore: true };
        act(() => root.render(<ModelEffortMenu label="Run setup" modelLabel="Model" options={models} layout={layout} value="model-b" onChange={vi.fn()} moreLabel="More"
            effort={{ label: 'Thinking', options: [], value: null, onChange: vi.fn() }} />));
        act(() => host.querySelector<HTMLButtonElement>('.me-trigger')!.click());
        const checked = document.querySelector('.me-panel [role="radio"][aria-checked="true"]');
        expect(checked?.textContent).toBe('Model B');
        expect(document.querySelector('[role="switch"]')).toBeNull();
    });

    it('each opening starts from the layout: an expanded 更多模型 folds again on the next open', () => {
        const layout = { primary: [models[0]], more: [models[1]], longContext: null, selectedInMore: false };
        act(() => root.render(<ModelEffortMenu label="Run setup" modelLabel="Model" options={models} layout={layout} value="model-a" onChange={vi.fn()} moreLabel="More"
            effort={{ label: 'Thinking', options: [], value: null, onChange: vi.fn() }} />));
        const trigger = host.querySelector<HTMLButtonElement>('.me-trigger')!;
        act(() => trigger.click());
        act(() => document.querySelector<HTMLButtonElement>('.me-more')!.click());
        expect(document.querySelectorAll('.me-panel [role="radio"]').length).toBe(2);
        act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
        act(() => trigger.click());
        expect(document.querySelectorAll('.me-panel [role="radio"]').length).toBe(1);
    });

    it('read-only model (Gemini): no model rows, the trigger names the machine config', () => {
        act(() => root.render(<ModelEffortMenu label="Run setup" modelLabel="Model" options={[]} value={null} onChange={vi.fn()} triggerLabel="Machine config"
            readOnly={{ value: 'Set by the machine config', hint: 'Change it in Settings' }}
            effort={{ label: 'Thinking', options: [], value: null, onChange: vi.fn() }} />));
        expect(host.querySelector('.me-trigger')!.textContent).toBe('Machine config');
        act(() => host.querySelector<HTMLButtonElement>('.me-trigger')!.click());
        expect(document.querySelector('.me-panel [role="radio"]')).toBeNull();
        expect(document.querySelector('.me-readonly')!.textContent).toContain('Set by the machine config');
    });
});

describe('B-849a phone: one bottom sheet', () => {
    it('opens a single sheet (no popover, no picker inside it) on a coarse narrow screen', () => {
        const matchMedia = window.matchMedia;
        window.matchMedia = ((query: string) => ({ matches: query.includes('pointer: coarse'), media: query, addEventListener: () => {}, removeEventListener: () => {} })) as unknown as typeof window.matchMedia;
        try {
            act(() => root.render(<ModelEffortMenu label="Run setup" modelLabel="Model" options={models} value="model-a" onChange={vi.fn()}
                effort={{ label: 'Thinking', options: levels, value: 'low', onChange: vi.fn() }} />));
            act(() => host.querySelector<HTMLButtonElement>('.me-trigger')!.click());
            const sheet = document.querySelector('.me-sheet')!;
            expect(sheet).not.toBeNull();
            expect(document.querySelector('.me-panel')).toBeNull();
            expect(sheet.querySelector('[role="combobox"]')).toBeNull();
            expect(sheet.querySelectorAll('.me-models [role="radio"]').length).toBe(2);
            expect(sheet.querySelectorAll('.effort-seg [role="radio"]').length).toBe(4);
        } finally {
            window.matchMedia = matchMedia;
        }
    });
});

describe('B-849a2: a disabled entry explains itself instead of being picked', () => {
    it('cannot be chosen unless it is the current selection', () => {
        const onChange = vi.fn();
        const options = [{ key: 'default', name: 'Machine config', description: 'New sessions only', disabled: true }, models[0]];
        const render = (value: string) => act(() => root.render(<ModelEffortMenu label="Run setup" modelLabel="Model" options={options} value={value} onChange={onChange}
            effort={{ label: 'Thinking', options: levels, value: 'low', onChange: vi.fn() }} />));
        render('model-a');
        act(() => host.querySelector<HTMLButtonElement>('.me-trigger')!.click());
        const row = () => document.querySelector<HTMLButtonElement>('.me-panel .me-models [role="radio"]')!;
        expect(row().getAttribute('aria-disabled')).toBe('true');
        expect(row().classList.contains('me-model--off')).toBe(true);
        act(() => row().click());
        expect(onChange).not.toHaveBeenCalled();
        render('default');
        expect(row().getAttribute('aria-disabled')).toBeNull();
        expect(row().getAttribute('aria-checked')).toBe('true');
    });
});
