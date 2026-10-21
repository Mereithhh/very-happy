// @vitest-environment happy-dom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SuggestInput } from './SuggestInput';

/** B-714 — <input list> + <datalist> replacement: free text, themed suggestions. */
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.body.innerHTML = '';
});

const ZONES = ['Asia/Singapore', 'Asia/Shanghai', 'Europe/London', 'America/New_York'];
function Field({ initial = '', onOuterKey }: { initial?: string; onOuterKey?: (key: string) => void }) {
    const [value, setValue] = useState(initial);
    return <div onKeyDown={(e) => onOuterKey?.(e.key)}><SuggestInput aria-label="Time zone" value={value} onValueChange={setValue} suggestions={ZONES} /></div>;
}
const input = () => host.querySelector<HTMLInputElement>('input')!;
function type(text: string) {
    act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input(), text);
        input().dispatchEvent(new Event('input', { bubbles: true }));
    });
}
function key(k: string) {
    act(() => { input().dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })); });
}
const options = () => [...document.querySelectorAll('[role="option"]')].map((o) => o.textContent);

describe('SuggestInput', () => {
    it('typing keeps free text and filters the themed list; no native datalist', () => {
        render(<Field />);
        expect(input().getAttribute('role')).toBe('combobox');
        expect(input().hasAttribute('list')).toBe(false);
        type('asia');
        expect(input().value).toBe('asia');
        expect(options()).toEqual(['Asia/Singapore', 'Asia/Shanghai']);
        expect(input().getAttribute('aria-expanded')).toBe('true');
        type('Mars/Base');
        expect(document.querySelector('[role="listbox"]')).toBeNull();
        expect(input().value).toBe('Mars/Base');
    });

    it('↓ highlights, Enter takes the suggestion', () => {
        render(<Field />);
        type('asia');
        key('ArrowDown');
        key('ArrowDown');
        const id = input().getAttribute('aria-activedescendant')!;
        expect(document.getElementById(id)?.textContent).toBe('Asia/Shanghai');
        key('Enter');
        expect(input().value).toBe('Asia/Shanghai');
        expect(document.querySelector('[role="listbox"]')).toBeNull();
    });

    it('Esc closes the list without reaching the dialog around it; a second Esc does', () => {
        const outer = vi.fn();
        render(<Field onOuterKey={outer} />);
        type('eu');
        key('Escape');
        expect(document.querySelector('[role="listbox"]')).toBeNull();
        expect(outer).not.toHaveBeenCalled();
        key('Escape');
        expect(outer).toHaveBeenCalledWith('Escape');
    });

    it('an exact value lists every suggestion as alternatives', () => {
        render(<Field initial="Europe/London" />);
        act(() => input().click());
        expect(options()).toEqual(ZONES);
    });
});

function render(node: React.ReactNode) {
    act(() => root.render(node));
}
