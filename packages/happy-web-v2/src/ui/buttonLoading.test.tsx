// @vitest-environment happy-dom
/**
 * B-590 (design-language §6 反馈时机): Button `loading` disables at once, shows
 * the Spinner only after ~200ms, and never changes what occupies the width.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Button } from './Button';
import { VISIBLE_LOADING_DELAY_MS } from './useDelayedFlag';

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers(); });

const btn = () => host.querySelector('button')!;
const spinner = () => host.querySelector('.vh-spinner');
const render = (el: React.ReactElement) => act(() => root.render(el));
const advance = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });

describe('Button loading (B-590)', () => {
    it('disables immediately but delays the Spinner ~200ms', () => {
        render(<Button loading={false}>Save</Button>);
        render(<Button loading>Save</Button>);
        expect(btn().disabled).toBe(true);
        expect(btn().getAttribute('aria-busy')).toBe('true');
        expect(spinner()).toBeNull();
        advance(VISIBLE_LOADING_DELAY_MS - 1);
        expect(spinner()).toBeNull();
        advance(1);
        expect(spinner()).not.toBeNull();
    });

    it('a fast round trip never shows a Spinner, and finishing hides it at once', () => {
        render(<Button loading>Save</Button>);
        advance(120);
        render(<Button loading={false}>Save</Button>);
        advance(500);
        expect(spinner()).toBeNull();
        render(<Button loading>Save</Button>);
        advance(VISIBLE_LOADING_DELAY_MS);
        expect(spinner()).not.toBeNull();
        render(<Button loading={false}>Save</Button>);
        expect(spinner()).toBeNull();
        expect(btn().disabled).toBe(false);
    });

    it('without a leftIcon the label stays in the box (transparent) and the Spinner overlays it', () => {
        render(<Button loading rightIcon={<i className="ri" />}>Save changes</Button>);
        advance(VISIBLE_LOADING_DELAY_MS);
        expect(btn().classList.contains('vh-btn--busy')).toBe(true);
        expect(btn().querySelector('.vh-btn-label')!.textContent).toBe('Save changes');
        // rightIcon keeps its place (it used to be dropped → width change)
        expect(btn().querySelector('.ri')).not.toBeNull();
        expect([...btn().children].some((c) => c.classList.contains('vh-btn-spinner'))).toBe(true);
    });

    it('with a leftIcon the Spinner shares the icon slot instead of adding one', () => {
        render(<Button leftIcon={<i className="li" />}>Send</Button>);
        const slot = btn().querySelector('.vh-btn-slot')!;
        expect(slot.querySelector('.li')).not.toBeNull();
        render(<Button loading leftIcon={<i className="li" />}>Send</Button>);
        advance(VISIBLE_LOADING_DELAY_MS);
        expect(slot.getAttribute('data-busy')).toBe('true');
        expect(slot.querySelector('.li')).not.toBeNull();
        expect(slot.querySelector('.vh-btn-spinner')).not.toBeNull();
        expect(btn().classList.contains('vh-btn--busy')).toBe(false);
        expect(btn().textContent).toBe('Send');
    });
});
