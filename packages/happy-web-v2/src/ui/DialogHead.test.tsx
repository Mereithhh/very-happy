// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DialogHead, moveFocusIntoDialog } from './DialogHead';

function card(html: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'vh-dialog';
  el.innerHTML = html;
  document.body.appendChild(el);
  return el;
}

describe('DialogHead (B-728)', () => {
  afterEach(() => { document.body.innerHTML = ''; });

  it('renders the title, an optional description and the × last in the row', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const onClose = vi.fn();
    await act(async () => createRoot(host).render(<DialogHead title="新会话" description="build-box" titleId="t1" onClose={onClose} closeLabel="关闭" />));
    const head = host.querySelector('.vh-dialog-head')!;
    expect(head.querySelector('h2#t1')?.textContent).toBe('新会话');
    expect(head.querySelector('.vh-dialog-description')?.textContent).toBe('build-box');
    expect(head.lastElementChild?.matches('button.vh-dialog-close[aria-label="关闭"]')).toBe(true);
    (head.lastElementChild as HTMLButtonElement).click();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('no onClose, no ×', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    await act(async () => createRoot(host).render(<DialogHead title="Importing" />));
    expect(host.querySelector('.vh-dialog-close')).toBeNull();
  });

  it('moves focus from the trigger behind into the dialog: first field on a fine pointer', () => {
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    trigger.focus();
    const el = card('<button class="vh-dialog-close">x</button><select disabled></select><input id="f" />');
    moveFocusIntoDialog(el, true);
    expect(document.activeElement?.id).toBe('f');
  });

  it('on touch the card itself takes focus (no surprise keyboard)', () => {
    const el = card('<input id="f" />');
    moveFocusIntoDialog(el, false);
    expect(document.activeElement).toBe(el);
    expect(el.tabIndex).toBe(-1);
  });

  it('leaves an autofocused field alone', () => {
    const el = card('<input id="a" /><input id="b" />');
    (el.querySelector('#b') as HTMLInputElement).focus();
    moveFocusIntoDialog(el, true);
    expect(document.activeElement?.id).toBe('b');
  });
});
