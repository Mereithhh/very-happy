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
        act(() => root.render(<ModelEffortMenu label="Model" options={models} value="model-a" onChange={vi.fn()}
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
            <ModelEffortMenu label="Model" options={models} value={model} onChange={vi.fn()}
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

    it('keeps the real popover slider and exact model/effort callbacks usable', async () => {
        const onModelChange = vi.fn();
        const onEffortChange = vi.fn();
        act(() => root.render(<ModelEffortMenu label="Model" options={models} value="model-a" onChange={onModelChange}
            effort={{ label: 'Thinking', options: levels, value: 'xhigh', onChange: onEffortChange }} />));
        act(() => host.querySelector('button')!.click());
        const panel = document.querySelector('.me-panel')!;
        expect(panel.querySelector('.effort-slider--max .effort-energy')).not.toBeNull();
        const picker = panel.querySelector<HTMLButtonElement>('[role="combobox"]')!;
        expect(picker.getAttribute('aria-labelledby')).toBe(panel.querySelector('.me-model-label')!.id);
        act(() => picker.click());
        // Radix arms its outside-pointerdown listeners on a 0ms timer.
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
        const option = [...document.querySelectorAll<HTMLElement>('[data-vh-picker-surface] [role="option"]')].find((el) => el.textContent === 'Model B')!;
        // B-714: the picker is its own portal; a press inside it is not "outside" the model panel.
        act(() => {
            option.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
            option.click();
        });
        expect(onModelChange).toHaveBeenCalledExactlyOnceWith('model-b');
        expect(document.querySelector('.me-panel')).not.toBeNull();
        const range = panel.querySelector('input')!;
        const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
        act(() => {
            setValue.call(range, '1');
            range.dispatchEvent(new Event('input', { bubbles: true }));
            range.dispatchEvent(new Event('change', { bubbles: true }));
        });
        expect(onEffortChange).toHaveBeenCalledExactlyOnceWith('low');
        // control: a real outside press still closes the panel
        act(() => { document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true })); });
        expect(document.querySelector('.me-panel')).toBeNull();
    });
});

describe('B-714 model picker groups', () => {
    const open = (el: Element) => act(() => { el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })); });
    it('with custom models: default ungrouped, then 目录 and 自定义 headings', () => {
        act(() => root.render(<ModelEffortMenu label="Model" value="default" onChange={vi.fn()}
            options={[{ key: 'default', name: 'Default' }, ...models, { key: 'gw/opus', name: 'gw/opus' }]}
            groups={{ catalog: 'Models', custom: 'Custom', customKeys: ['gw/opus'] }}
            effort={{ label: 'Thinking', options: levels, value: 'low', onChange: vi.fn() }} />));
        act(() => host.querySelector<HTMLButtonElement>('.me-trigger')!.click());
        open(document.querySelector('.me-panel .vh-select-trigger')!);
        const groups = [...document.querySelectorAll('.vh-picker [role="group"]')];
        expect(groups.map((g) => g.querySelector('.vh-picker-group-label')?.textContent)).toEqual(['Models', 'Custom']);
        expect(groups[1].textContent).toContain('gw/opus');
        expect(document.querySelector('.vh-picker [role="option"]')?.textContent).toContain('Default');
    });

    it('without custom models there are no headings', () => {
        act(() => root.render(<ModelEffortMenu label="Model" value="model-a" onChange={vi.fn()} options={models}
            groups={{ catalog: 'Models', custom: 'Custom', customKeys: [] }}
            effort={{ label: 'Thinking', options: levels, value: 'low', onChange: vi.fn() }} />));
        act(() => host.querySelector<HTMLButtonElement>('.me-trigger')!.click());
        open(document.querySelector('.me-panel .vh-select-trigger')!);
        expect(document.querySelectorAll('.vh-picker-group-label').length).toBe(0);
    });
});
