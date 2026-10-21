// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ElicitationRequestView } from './ElicitationRequestView';

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
});

afterEach(() => { act(() => root.unmount()); host.remove(); });

const many = ['a', 'b', 'c', 'd', 'e', 'f'];
const request = {
    requestedSchema: {
        properties: {
            size: { title: 'Size', enum: ['S', 'M', 'L'] },
            region: { title: 'Region', enum: many },
            optional: { title: 'Optional', enum: many },
            confirm: { title: 'Confirm', type: 'boolean' },
        },
        required: ['size', 'region'],
    },
};

const submit = () => act(() => { host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });

describe('ElicitationRequestView controls (B-714)', () => {
    it('renders no native select / checkbox; short enum is segmented, long enum is a menu', () => {
        act(() => root.render(<ElicitationRequestView request={request} disabled={false} submitLabel="Send" onSubmit={vi.fn()} />));
        expect(host.querySelector('select, option')).toBeNull();
        const size = host.querySelector<HTMLElement>('.vh-segmented')!;
        expect(size.getAttribute('aria-labelledby')).toBe(host.querySelector('.perm-elicitation-field > span')!.id);
        expect([...size.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['S', 'M', 'L']);
        const menus = [...host.querySelectorAll<HTMLButtonElement>('[role="combobox"]')];
        expect(menus).toHaveLength(2);
        expect(menus[0].getAttribute('aria-required')).toBe('true');
        expect(host.querySelector('.vh-checkbox input[type="checkbox"]')).not.toBeNull();
    });

    it('a required segmented enum left empty blocks submit with a visible reason; picks submit the original enum values', () => {
        const onSubmit = vi.fn();
        act(() => root.render(<ElicitationRequestView request={request} disabled={false} submitLabel="Send" onSubmit={onSubmit} />));
        submit();
        expect(onSubmit).not.toHaveBeenCalled();
        expect(host.querySelector('.perm-elicitation-field [role="alert"]')).not.toBeNull();

        act(() => [...host.querySelectorAll<HTMLButtonElement>('.vh-segmented button')].find((b) => b.textContent === 'M')!.click());
        expect(host.querySelector('.perm-elicitation-field [role="alert"]')).toBeNull();
        const region = host.querySelectorAll<HTMLButtonElement>('[role="combobox"]')[0];
        act(() => region.click());
        act(() => [...document.querySelectorAll<HTMLElement>('[data-vh-picker-surface] [role="option"]')].find((el) => el.textContent === 'c')!.click());
        act(() => host.querySelector<HTMLInputElement>('.vh-checkbox input')!.click());
        submit();
        expect(onSubmit).toHaveBeenCalledExactlyOnceWith({ size: 'M', region: 'c', confirm: true });
    });

    it('an optional menu keeps an explicit empty choice that removes the value', () => {
        const onSubmit = vi.fn();
        act(() => root.render(<ElicitationRequestView request={{ requestedSchema: { properties: { optional: { enum: many, default: 'b' } } } }} disabled={false} submitLabel="Send" onSubmit={onSubmit} />));
        const menu = host.querySelector<HTMLButtonElement>('[role="combobox"]')!;
        expect(menu.textContent).toContain('b');
        act(() => menu.click());
        act(() => [...document.querySelectorAll<HTMLElement>('[data-vh-picker-surface] [role="option"]')].find((el) => el.textContent === '—')!.click());
        submit();
        expect(onSubmit).toHaveBeenCalledExactlyOnceWith({});
    });
});
