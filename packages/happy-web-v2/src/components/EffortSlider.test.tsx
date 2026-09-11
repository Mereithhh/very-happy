// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EffortSlider, isMaximumEffort } from './EffortSlider';

const options = ['low', 'medium', 'xhigh'].map((key) => ({ key, name: key }));
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

function changeIndex(index: number) {
    const input = host.querySelector('input')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    act(() => {
        setter.call(input, String(index));
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
    });
}

describe('EffortSlider', () => {
    it.each([null, 'obsolete-ultra'])('keeps %s distinct from a directly selectable first level', (value) => {
        const onChange = vi.fn();
        act(() => root.render(<EffortSlider label="Thinking" options={options} value={value} onChange={onChange} />));
        expect(host.querySelector('input')?.value).toBe('-1');
        changeIndex(0);
        expect(onChange).toHaveBeenCalledExactlyOnceWith('low');
    });

    it.each([null, 'obsolete-ultra'])('can select the only supported level from %s', (value) => {
        const onChange = vi.fn();
        const onlyOff = [{ key: 'off', name: 'Off' }];
        act(() => root.render(<EffortSlider label="Thinking" options={onlyOff} value={value} onChange={onChange} />));
        expect(host.querySelector('input')?.disabled).toBe(false);
        changeIndex(0);
        expect(onChange).toHaveBeenCalledExactlyOnceWith('off');
        act(() => root.render(<EffortSlider label="Thinking" options={onlyOff} value="off" onChange={onChange} />));
        expect(host.querySelector('input')?.disabled).toBe(true);
    });

    it('emits exact supported backend keys and replays after the owner changes the value', () => {
        const onChange = vi.fn();
        const render = (value: string) => act(() => root.render(<EffortSlider label="Thinking" options={options} value={value} onChange={onChange} />));
        render('medium');
        changeIndex(2);
        expect(onChange).toHaveBeenLastCalledWith('xhigh');
        // Wait for the controlled owner to accept the new level before decorating it.
        expect(host.querySelector('.effort-slider-burst')).toBeNull();
        render('xhigh');
        const firstBurst = host.querySelector('.effort-slider-burst');
        expect(firstBurst).not.toBeNull();
        render('low'); // Another settings surface changes the controlled value.
        changeIndex(2);
        render('xhigh');
        expect(host.querySelector('.effort-slider-burst')).not.toBe(firstBurst);
        expect(onChange).toHaveBeenCalledTimes(2);
    });

    it('does not offer an unsupported level when the backend supplies no options', () => {
        act(() => root.render(<EffortSlider label="Thinking" options={[]} value={null} onChange={vi.fn()} />));
        expect(host.querySelector('input')).toBeNull();
    });

    it('marks only the highest positive supported level as maximum', () => {
        const render = (value: string) => act(() => root.render(<EffortSlider label="Thinking" options={options} value={value} onChange={vi.fn()} />));
        render('xhigh'); expect(host.querySelector('.effort-slider--max')).not.toBeNull();
        render('medium'); expect(host.querySelector('.effort-slider--max')).toBeNull();
        const noReasoning = [{ key: 'default', name: 'Default' }, { key: 'off', name: 'Off' }];
        act(() => root.render(<EffortSlider label="Thinking" options={noReasoning} value="off" onChange={vi.fn()} />));
        expect(host.querySelector('.effort-slider--max')).toBeNull();
    });

    it.each(['default', '__code_default__', 'off', 'none'])('never energizes the %s sentinel even if listed last', (key) => {
        const levels = [{ key: 'low', name: 'Low' }, { key, name: key }];
        act(() => root.render(<EffortSlider label="Thinking" options={levels} value="low" onChange={vi.fn()} />));
        changeIndex(1);
        act(() => root.render(<EffortSlider label="Thinking" options={levels} value={key} onChange={vi.fn()} />));
        expect(host.querySelector('.effort-slider--max')).toBeNull();
        expect(host.querySelector('.effort-energy')).toBeNull();
        expect(host.querySelector('.effort-slider-burst')).toBeNull();
    });

    it('only mounts decorative energy at the current model’s supported maximum', () => {
        const render = (value: string | null, levels = options) => act(() => root.render(
            <EffortSlider label="Thinking" options={levels} value={value} onChange={vi.fn()} />,
        ));
        render('xhigh');
        expect(host.querySelector('.effort-energy')?.getAttribute('aria-hidden')).toBe('true');
        expect(host.querySelector('.effort-energy-flow')).not.toBeNull();
        expect(host.querySelector('.effort-energy-glint')).not.toBeNull();
        expect(host.querySelector('input')?.getAttribute('aria-valuetext')).toBe('xhigh');
        expect(host.querySelector('output')?.textContent).toBe('xhigh');
        render('xhigh', [...options, { key: 'ultra', name: 'ultra' }]);
        expect(host.querySelector('.effort-energy')).toBeNull();
        render(null);
        expect(host.querySelector('.effort-energy')).toBeNull();
        render('obsolete-ultra');
        expect(host.querySelector('.effort-energy')).toBeNull();
        render('medium');
        expect(host.querySelector('.effort-energy')).toBeNull();
    });

    it('shares the maximum predicate without treating unsupported or single-stop controls as max', () => {
        expect(isMaximumEffort(options, 'xhigh')).toBe(true);
        expect(isMaximumEffort(options, 'ultra')).toBe(false);
        expect(isMaximumEffort([], null)).toBe(false);
        expect(isMaximumEffort([{ key: 'off', name: 'Off' }], 'off')).toBe(false);
        expect(isMaximumEffort([{ key: 'high', name: 'High' }], 'high')).toBe(false);
    });

    it('disables updates while busy', () => {
        const onChange = vi.fn();
        act(() => root.render(<EffortSlider label="Thinking" options={options} value="low" onChange={onChange} busy />));
        expect(host.querySelector('input')?.disabled).toBe(true);
        changeIndex(2);
        expect(onChange).not.toHaveBeenCalled();
    });
});
