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

    it('keeps the real popover slider and exact model/effort callbacks usable', () => {
        const onModelChange = vi.fn();
        const onEffortChange = vi.fn();
        act(() => root.render(<ModelEffortMenu label="Model" options={models} value="model-a" onChange={onModelChange}
            effort={{ label: 'Thinking', options: levels, value: 'xhigh', onChange: onEffortChange }} />));
        act(() => host.querySelector('button')!.click());
        const panel = document.querySelector('.me-panel')!;
        expect(panel.querySelector('.effort-slider--max .effort-energy')).not.toBeNull();
        const select = panel.querySelector('select')!;
        act(() => { select.value = 'model-b'; select.dispatchEvent(new Event('change', { bubbles: true })); });
        expect(onModelChange).toHaveBeenCalledExactlyOnceWith('model-b');
        const range = panel.querySelector('input')!;
        const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
        act(() => {
            setValue.call(range, '1');
            range.dispatchEvent(new Event('input', { bubbles: true }));
            range.dispatchEvent(new Event('change', { bubbles: true }));
        });
        expect(onEffortChange).toHaveBeenCalledExactlyOnceWith('low');
    });
});
