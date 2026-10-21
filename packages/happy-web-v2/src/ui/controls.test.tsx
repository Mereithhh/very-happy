// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Checkbox } from './Checkbox';
import { Segmented } from './Segmented';
import { Summary } from './Summary';

/**
 * B-714 — UI-P1-08 / P1-09: the design-system Checkbox (no system blue, immune
 * to parent `input { … }` field rules) and Summary (chevron instead of the
 * browser triangle). Design lint `native-control` allows the native elements
 * only in these two files.
 */
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
});

describe('Checkbox', () => {
    it('labelled row: native input for forms/AT, toggles through onCheckedChange', () => {
        const onChange = vi.fn();
        act(() => root.render(<Checkbox checked={false} onCheckedChange={onChange} name="push" required>Push after commit</Checkbox>));
        const label = host.querySelector('label.vh-checkbox')!;
        const input = label.querySelector<HTMLInputElement>('input.vh-checkbox-input')!;
        expect(input.type).toBe('checkbox');
        expect(input.name).toBe('push');
        expect(input.required).toBe(true);
        expect(label.textContent).toBe('Push after commit');
        act(() => input.click());
        expect(onChange).toHaveBeenCalledWith(true);
    });

    it('bare box for rows that already are a <label>; indeterminate is announced as mixed', () => {
        act(() => root.render(<label><Checkbox checked={false} indeterminate aria-label="all" /> all files</label>));
        expect(host.querySelector('label label')).toBeNull();
        const input = host.querySelector<HTMLInputElement>('.vh-checkbox.is-bare input')!;
        expect(input.indeterminate).toBe(true);
        expect(input.getAttribute('aria-checked')).toBe('mixed');
    });

    it('css: appearance none, token colours, (0,2,0) selector beats `.parent input` field rules, 44px coarse row', () => {
        const css = readFileSync(join(__dirname, 'controls.css'), 'utf8');
        const rule = css.slice(css.indexOf('.vh-checkbox-control .vh-checkbox-input {'));
        expect(rule).toMatch(/^\.vh-checkbox-control \.vh-checkbox-input \{[^}]*appearance: none;[^}]*padding: 0;[^}]*border: 1px solid var\(--line-heavy\);[^}]*background: var\(--bg-1\);/);
        expect(css).toMatch(/\.vh-checkbox-control \.vh-checkbox-input:checked,\s*\.vh-checkbox-control \.vh-checkbox-input:indeterminate \{ border-color: var\(--text\); background: var\(--text\); \}/);
        expect(css).toMatch(/@media \(pointer: coarse\) \{\s*\.vh-checkbox:not\(\.is-bare\) \{ min-height: 44px; \}/);
        expect(css).not.toMatch(/#[0-9a-f]{3,6}\b|rgba?\(/i);
    });
});

describe('Summary', () => {
    it('renders a chevron-led summary with the triangle hidden', () => {
        act(() => root.render(<details><Summary className="x">More</Summary><p>body</p></details>));
        const summary = host.querySelector('summary')!;
        expect(summary.className).toBe('vh-summary x');
        expect(summary.querySelector('svg.vh-summary-chevron')).not.toBeNull();
        expect(summary.textContent).toBe('More');
        const css = readFileSync(join(__dirname, 'controls.css'), 'utf8');
        expect(css).toMatch(/\.vh-summary \{[^}]*list-style: none;/);
        expect(css).toMatch(/\.vh-summary::-webkit-details-marker \{ display: none; \}/);
        expect(css).toMatch(/details\[open\] > \.vh-summary > \.vh-summary-chevron \{ transform: rotate\(90deg\); \}/);
    });
});

describe('Segmented', () => {
    it('aria-pressed buttons in a named group; the hidden input carries the value for FormData', () => {
        const onChange = vi.fn();
        act(() => root.render(<form><Segmented label="Kind" name="kind" value="note" onChange={onChange}
            options={[{ value: 'decision', label: 'Decision' }, { value: 'note', label: 'Note' }]} /></form>));
        const group = host.querySelector('[role="group"].vh-segmented')!;
        expect(group.getAttribute('aria-label')).toBe('Kind');
        const buttons = [...group.querySelectorAll('button')];
        expect(buttons.map((b) => b.getAttribute('aria-pressed'))).toEqual(['false', 'true']);
        expect(new FormData(host.querySelector('form')!).get('kind')).toBe('note');
        act(() => buttons[0].click());
        expect(onChange).toHaveBeenCalledWith('decision');
        act(() => buttons[1].click());
        expect(onChange).toHaveBeenCalledTimes(1);
    });
});
