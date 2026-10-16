// @vitest-environment happy-dom
/**
 * B-612: a thinking block that stops being live folds only when that cannot
 * move what the reader is looking at (B-607's rule); otherwise the fold waits
 * for the reader to follow the live end again. A manual toggle always wins.
 */
import { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ReaderFollowContext, createReaderFollow, type ReaderFollowSource } from './readerFollow';
import { useLiveDisclosure } from './useLiveDisclosure';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const VIEW_BOTTOM = 600;
let host: HTMLDivElement;
let root: Root;
let reader: ReaderFollowSource;
let blockTop = 0;
let restoreRect = () => {};
let toggle: () => void = () => {};

function Probe({ live }: { live: boolean }) {
    const ref = useRef<HTMLDivElement>(null);
    const [open, onToggle] = useLiveDisclosure(live, ref);
    toggle = onToggle;
    return <div ref={ref} className="msg-thinking" data-open={open ? '1' : '0'} />;
}

beforeEach(() => {
    reader = createReaderFollow(false);
    blockTop = 0;
    const rect = HTMLElement.prototype.getBoundingClientRect;
    restoreRect = () => { HTMLElement.prototype.getBoundingClientRect = rect; };
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
        const box = rect.call(this);
        if (this.classList.contains('cl-scroll')) return { ...box.toJSON(), top: 0, bottom: VIEW_BOTTOM } as DOMRect;
        if (this.classList.contains('msg-thinking')) return { ...box.toJSON(), top: blockTop, bottom: blockTop + 2000 } as DOMRect;
        return box;
    };
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});

afterEach(() => {
    act(() => root.unmount());
    host.remove();
    restoreRect();
});

const render = (live: boolean) => act(() => root.render(
    <ReaderFollowContext.Provider value={reader}><div className="cl-scroll"><Probe live={live} /></div></ReaderFollowContext.Provider>,
));
const isOpen = () => host.querySelector('.msg-thinking')?.getAttribute('data-open') === '1';

describe('B-612 thinking auto-fold respects the detached reader', () => {
    it('reader detached, block above/in the viewport: stays open, folds on re-follow', () => {
        blockTop = -1500;
        render(true);
        render(false);
        expect(isOpen()).toBe(true);
        act(() => reader.set(true));
        expect(isOpen()).toBe(false);
    });

    it('reader following: folds immediately', () => {
        reader.set(true);
        blockTop = -1500;
        render(true);
        render(false);
        expect(isOpen()).toBe(false);
    });

    it('block entirely below the viewport: folds immediately even when detached', () => {
        blockTop = VIEW_BOTTOM + 10;
        render(true);
        render(false);
        expect(isOpen()).toBe(false);
    });

    it('a manual toggle cancels the deferred fold', () => {
        blockTop = 100;
        render(true);
        render(false);
        act(() => toggle()); // user folds…
        act(() => toggle()); // …and reopens it to keep reading
        act(() => reader.set(true));
        expect(isOpen()).toBe(true);
    });

    it('becoming live again cancels the deferred fold (live→done→live flicker)', () => {
        blockTop = 100;
        render(true);
        render(false);
        render(true);
        act(() => reader.set(true));
        expect(isOpen()).toBe(true);
    });

    it('a block that mounts not-live starts folded and stays so', () => {
        render(false);
        expect(isOpen()).toBe(false);
    });
});
