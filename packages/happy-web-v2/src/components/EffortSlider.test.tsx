// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EffortSlider } from './EffortSlider';

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
        const firstBurst = host.querySelector('.effort-slider-burst');
        expect(firstBurst).not.toBeNull();
        render('xhigh');
        render('low'); // Another settings surface changes the controlled value.
        changeIndex(2);
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

    it('disables updates while busy', () => {
        const onChange = vi.fn();
        act(() => root.render(<EffortSlider label="Thinking" options={options} value="low" onChange={onChange} busy />));
        expect(host.querySelector('input')?.disabled).toBe(true);
        changeIndex(2);
        expect(onChange).not.toHaveBeenCalled();
    });
});
