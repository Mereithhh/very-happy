// @vitest-environment happy-dom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const persisted: { value: number | null; writes: (number | null)[] } = { value: null, writes: [] };
vi.mock('@/i18n/useTranslation', () => ({ useTranslation: () => ({ lang: 'en' }) }));
vi.mock('@/sync/storage', async () => {
    const react = await import('react');
    return {
        useLocalSettingMutable: () => {
            const [value, setValue] = react.useState<number | null>(persisted.value);
            return [value, (next: number | null) => { persisted.value = next; persisted.writes.push(next); setValue(next); }];
        },
    };
});
import { useFilesPanelWidth } from './useFilesPanelWidth';

const collapse = vi.fn();
let host: HTMLDivElement;
let root: Root;

function Fixture({ collapsible = true }: { collapsible?: boolean }) {
    const [open, setOpen] = useState(true);
    const { width, collapseArmed, handleProps } = useFilesPanelWidth(collapsible ? { onCollapse: () => { collapse(); setOpen(false); } } : undefined);
    return <div className="row">
        {open && <div className="handle" {...handleProps} />}
        {open && <aside data-width={width} data-armed={String(collapseArmed)} />}
        {!open && <button onClick={() => setOpen(true)}>reopen</button>}
    </div>;
}

beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    persisted.value = 500;
    persisted.writes = [];
    collapse.mockClear();
    vi.stubGlobal('innerWidth', 1440);
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    // The row's right edge is the panel's anchored edge.
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
        return { left: 0, top: 0, right: this.classList.contains('row') ? 1440 : 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON() {} } as DOMRect;
    });
    HTMLElement.prototype.setPointerCapture = vi.fn();
});

afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.body.className = '';
});

const handle = () => host.querySelector<HTMLDivElement>('.handle')!;
const aside = () => host.querySelector('aside');
const width = () => Number(aside()?.getAttribute('data-width'));
async function pointer(type: string, clientX: number, init: PointerEventInit = {}) {
    await act(async () => handle().dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 7, pointerType: 'mouse', button: 0, clientX, clientY: 300, ...init })));
}

function LegacyFixture({ onEnd }: { onEnd: () => void }) {
    const { width, onHandleMouseDown } = useFilesPanelWidth({ onDragEnd: onEnd });
    return <div className="row"><div className="handle" onMouseDown={onHandleMouseDown} /><aside data-width={width} /></div>;
}

describe('B-609 files panel separator', () => {
    it('keeps the terminal host\'s mouse path working through the same drag core (Escape included)', async () => {
        const onEnd = vi.fn();
        await act(async () => root.render(<LegacyFixture onEnd={onEnd} />));
        const mouse = (target: EventTarget, type: string, clientX: number) => act(async () => { target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX, clientY: 300 })); });
        await mouse(handle(), 'mousedown', 940);
        await mouse(window, 'mousemove', 840);
        expect(width()).toBe(600);
        await mouse(window, 'mouseup', 840);
        expect(persisted.writes).toEqual([600]);
        expect(onEnd).toHaveBeenCalledOnce();
        await mouse(handle(), 'mousedown', 840);
        await mouse(window, 'mousemove', 700);
        await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });
        expect(width()).toBe(600);
        expect(persisted.writes).toEqual([600]);
    });

    it('exposes a focusable separator with live aria values', async () => {
        await act(async () => root.render(<Fixture />));
        expect(handle().getAttribute('role')).toBe('separator');
        expect(handle().tabIndex).toBe(0);
        expect(handle().getAttribute('aria-valuenow')).toBe('500');
        expect(handle().getAttribute('aria-valuemin')).toBe('320');
        expect(handle().getAttribute('aria-valuemax')).toBe('864');
    });

    it('ignores the 4px dead zone, drags live, and persists once on release', async () => {
        await act(async () => root.render(<Fixture />));
        await pointer('pointerdown', 940);
        await pointer('pointermove', 937);
        expect(document.body.classList.contains('vh-col-resizing')).toBe(false);
        await pointer('pointermove', 840);
        expect(document.body.classList.contains('vh-col-resizing')).toBe(true);
        expect(width()).toBe(600);
        await pointer('pointermove', 740);
        expect(width()).toBe(700);
        expect(persisted.writes).toEqual([]);
        await pointer('pointerup', 740);
        expect(persisted.writes).toEqual([700]);
        expect(document.body.classList.contains('vh-col-resizing')).toBe(false);
    });

    it('Escape during a drag restores the start width and persists nothing', async () => {
        await act(async () => root.render(<Fixture />));
        await pointer('pointerdown', 940);
        await pointer('pointermove', 700);
        expect(width()).toBe(740);
        const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
        await act(async () => { document.body.dispatchEvent(escape); });
        expect(escape.defaultPrevented).toBe(true);
        expect(width()).toBe(500);
        await pointer('pointerup', 700);
        expect(persisted.writes).toEqual([]);
        expect(document.body.classList.contains('vh-col-resizing')).toBe(false);
    });

    it('releasing past the collapse threshold closes the panel and keeps the stored width for reopening', async () => {
        await act(async () => root.render(<Fixture />));
        await pointer('pointerdown', 940);
        await pointer('pointermove', 1200); // raw 240px: clamped to 320, not armed
        expect(width()).toBe(320);
        expect(aside()?.getAttribute('data-armed')).toBe('false');
        await pointer('pointermove', 1300); // raw 140px: armed
        expect(aside()?.getAttribute('data-armed')).toBe('true');
        expect(handle().getAttribute('data-collapse')).toBe('armed');
        await pointer('pointerup', 1300);
        expect(collapse).toHaveBeenCalledOnce();
        expect(aside()).toBeNull();
        expect(persisted.writes).toEqual([]);
        await act(async () => host.querySelector('button')!.click());
        expect(width()).toBe(500);
    });

    it('dragging back out of the collapse zone resizes instead of closing', async () => {
        await act(async () => root.render(<Fixture />));
        await pointer('pointerdown', 940);
        await pointer('pointermove', 1300);
        await pointer('pointermove', 1000);
        await pointer('pointerup', 1000);
        expect(collapse).not.toHaveBeenCalled();
        expect(persisted.writes).toEqual([440]);
    });

    it('never collapses a host that has no close path (terminal)', async () => {
        await act(async () => root.render(<Fixture collapsible={false} />));
        await pointer('pointerdown', 940);
        await pointer('pointermove', 1400);
        await pointer('pointerup', 1400);
        expect(persisted.writes).toEqual([320]);
    });

    it('pointercancel restores the start width', async () => {
        await act(async () => root.render(<Fixture />));
        await pointer('pointerdown', 940, { pointerType: 'touch' });
        await pointer('pointermove', 800, { pointerType: 'touch' });
        await pointer('pointercancel', 800, { pointerType: 'touch' });
        expect(width()).toBe(500);
        expect(persisted.writes).toEqual([]);
    });

    it('double-click resets to the responsive default and persists it', async () => {
        await act(async () => root.render(<Fixture />));
        await act(async () => handle().dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true })));
        expect(persisted.writes).toEqual([null]);
        expect(width()).toBe(Math.floor(1440 * 0.36));
    });

    it('keyboard: arrows step 16px (Shift 64px), Home/End jump to min/max', async () => {
        await act(async () => root.render(<Fixture />));
        const press = async (key: string, shiftKey = false) => {
            const event = new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true });
            await act(async () => { handle().dispatchEvent(event); });
            return event.defaultPrevented;
        };
        expect(await press('ArrowLeft')).toBe(true);
        expect(width()).toBe(516);
        await press('ArrowRight', true);
        expect(width()).toBe(452);
        await press('End');
        expect(width()).toBe(864);
        await press('Home');
        expect(width()).toBe(320);
        expect(await press('Tab')).toBe(false);
    });
});
