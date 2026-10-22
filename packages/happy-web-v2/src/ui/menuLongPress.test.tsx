// @vitest-environment happy-dom
/**
 * B-774 (QA5 O6): a touch long-press on a sidebar row opened 「重命名」 instead
 * of the menu — lifting the finger fired the browser's compat click on the
 * bottom-sheet item now under it. Measured in Chromium (390 px, touch):
 * tmp/vh-team-B-774/o6.mjs — before: row 11 → rename dialog; after: menu on
 * every row and a later tap on 重命名 still renames.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pencil } from 'lucide-react';
import { ActionContextMenu, RELEASE_CLICK_MS, createLongPressReleaseGuard } from './Menu';

describe('createLongPressReleaseGuard', () => {
  it('a press that opened the menu reports a long-press release, once', () => {
    const g = createLongPressReleaseGuard();
    g.press(); g.opened();
    expect(g.release()).toBe(true);
    expect(g.release()).toBe(false);
  });

  it('a menu opened without a press in progress (mouse right-click, keyboard) or after it ended is not one', () => {
    const g = createLongPressReleaseGuard();
    g.opened();
    expect(g.release()).toBe(false);
    g.press(); expect(g.release()).toBe(false); g.opened();
    expect(g.release()).toBe(false);
  });

  it('closing before the release clears it', () => {
    const g = createLongPressReleaseGuard();
    g.press(); g.opened(); g.closed();
    expect(g.release()).toBe(false);
  });
});

let root: Root | null = null;
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); });
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  document.body.innerHTML = '';
});

describe('ActionContextMenu long press (wiring)', () => {
  it('the release click after a touch long press does not select; a tap afterwards does', async () => {
    const onRename = vi.fn();
    const host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root!.render(
      <ActionContextMenu items={[{ key: 'rename', label: 'Rename', icon: Pencil, onSelect: onRename }]} sheetTitle="Row">
        <div className="row">row</div>
      </ActionContextMenu>,
    ));
    const row = document.querySelector('.row')!;
    const pointer = (type: string, target: EventTarget) => target.dispatchEvent(Object.assign(new MouseEvent(type, { bubbles: true, cancelable: true }), { pointerType: 'touch', pointerId: 1 }));
    await act(async () => { pointer('pointerdown', row); });
    // Radix opens on the long-press timer or on contextmenu; contextmenu is the same open path.
    await act(async () => { row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })); });
    const item = () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((el) => el.textContent?.includes('Rename'))!;
    expect(item()).toBeTruthy();
    await act(async () => { pointer('pointerup', document.body); });
    await act(async () => { item().click(); });
    expect(onRename).not.toHaveBeenCalled();
    expect(item()).toBeTruthy(); // menu still open
    await act(async () => { item().click(); });
    expect(onRename).toHaveBeenCalledTimes(1);
  });

  it('a release click outside the menu ends the watch: a quick tap on an item right after still selects', async () => {
    const onRename = vi.fn();
    const host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root!.render(
      <ActionContextMenu items={[{ key: 'rename', label: 'Rename', icon: Pencil, onSelect: onRename }]} sheetTitle="Row">
        <div className="row">row</div>
      </ActionContextMenu>,
    ));
    const row = document.querySelector('.row')!;
    const pointer = (type: string, target: EventTarget) => target.dispatchEvent(Object.assign(new MouseEvent(type, { bubbles: true, cancelable: true }), { pointerType: 'touch', pointerId: 1 }));
    await act(async () => { pointer('pointerdown', row); });
    await act(async () => { row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })); });
    await act(async () => { pointer('pointerup', document.body); });
    const item = () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((el) => el.textContent?.includes('Rename'))!;
    // the compat click hit the page outside the sheet (finger was high up)
    await act(async () => { document.body.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); });
    await act(async () => { item().click(); });
    expect(onRename).toHaveBeenCalledTimes(1);
  });

  it('no click at all after the release (the platform sent none): the watch times out', async () => {
    vi.useFakeTimers();
    try {
      const onRename = vi.fn();
      const host = document.createElement('div');
      document.body.append(host);
      root = createRoot(host);
      await act(async () => root!.render(
        <ActionContextMenu items={[{ key: 'rename', label: 'Rename', icon: Pencil, onSelect: onRename }]} sheetTitle="Row">
          <div className="row">row</div>
        </ActionContextMenu>,
      ));
      const row = document.querySelector('.row')!;
      const pointer = (type: string, target: EventTarget) => target.dispatchEvent(Object.assign(new MouseEvent(type, { bubbles: true, cancelable: true }), { pointerType: 'touch', pointerId: 1 }));
      await act(async () => { pointer('pointerdown', row); });
      await act(async () => { row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })); });
      await act(async () => { pointer('pointerup', document.body); });
      await act(async () => { vi.advanceTimersByTime(RELEASE_CLICK_MS + 1); });
      const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((el) => el.textContent?.includes('Rename'))!;
      await act(async () => { item.click(); });
      expect(onRename).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
