// @vitest-environment happy-dom
/** B-774 (QA5 O1): on a phone, the toast region moves below a full-height
 *  dialog's header while it is open and goes back when it closes. */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider, toast } from './Toast';

let root: Root | null = null;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.spyOn(window, 'matchMedia').mockImplementation((q: string) => ({ matches: q.includes('max-width: 600px'), media: q, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList);
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

const region = () => document.querySelector<HTMLElement>('.vh-toasts')!;
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const rect = (top: number, bottom: number, height = bottom - top) => ({ top, bottom, height, left: 0, right: 390, width: 390, x: 0, y: top, toJSON() {} }) as DOMRect;

describe('toast region over a dialog (B-774)', () => {
  it('sits below the header of a full-height dialog, back to default when it closes', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root!.render(<ToastProvider><span /></ToastProvider>));
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains('vh-toasts')) return rect(8, 64);
      if (this.classList.contains('vh-dialog-head')) return rect(0, 60);
      if (this.getAttribute('role') === 'dialog') return rect(0, 844);
      return rect(0, 0);
    });
    await act(async () => toast.action('“x” pushed a preview. Click to view', () => {}));
    expect(region().classList.contains('vh-toasts--below-dialog-head')).toBe(false);

    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.innerHTML = '<div class="vh-dialog-head">Title ✕</div>';
    document.body.append(dialog);
    await flush();
    expect(region().classList.contains('vh-toasts--below-dialog-head')).toBe(true);
    expect(region().style.getPropertyValue('--vh-toast-top')).toBe('68px');

    dialog.remove();
    await flush();
    expect(region().classList.contains('vh-toasts--below-dialog-head')).toBe(false);
  });

  it('a bottom sheet leaves the toast where it is', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root!.render(<ToastProvider><span /></ToastProvider>));
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains('vh-toasts')) return rect(8, 64);
      if (this.classList.contains('vh-dialog-head')) return rect(533, 600);
      if (this.getAttribute('role') === 'dialog') return rect(533, 844);
      return rect(0, 0);
    });
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.innerHTML = '<div class="vh-dialog-head">Title ✕</div>';
    document.body.append(dialog);
    await act(async () => toast.action('“x” pushed a preview. Click to view', () => {}));
    await flush();
    expect(region().classList.contains('vh-toasts--below-dialog-head')).toBe(false);
  });
});
