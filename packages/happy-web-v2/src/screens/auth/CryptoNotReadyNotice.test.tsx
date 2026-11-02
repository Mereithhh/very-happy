// @vitest-environment happy-dom
/**
 * B-859e: on short desktop windows the notice (top of the card) renders above the
 * viewport while the user is at the submit button below. On appear it must scroll itself
 * into view (nearest, so a visible notice does not jump) and take focus for screen readers.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CryptoNotReadyNotice } from './CryptoNotReadyNotice';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement, root: Root;
const scrollIntoView = vi.fn();
const realScroll = HTMLElement.prototype.scrollIntoView;
beforeEach(() => {
  scrollIntoView.mockReset();
  HTMLElement.prototype.scrollIntoView = scrollIntoView;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  HTMLElement.prototype.scrollIntoView = realScroll;
});

function render(show: boolean) {
  act(() => root.render(<div>{show && <CryptoNotReadyNotice />}<button type="submit">submit</button></div>));
}

describe('CryptoNotReadyNotice', () => {
  it('scrolls itself into view and takes focus when it appears', () => {
    render(false);
    host.querySelector('button')!.focus();
    render(true);
    const notice = host.querySelector<HTMLElement>('.auth-crypto-not-ready')!;
    expect(notice.getAttribute('role')).toBe('alert');
    expect(notice.tabIndex).toBe(-1);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
    expect(scrollIntoView.mock.contexts[0]).toBe(notice);
    expect(document.activeElement).toBe(notice);
  });

  it('scrolls again when a later submit shows it anew', () => {
    render(true);
    render(false);
    render(true);
    expect(scrollIntoView).toHaveBeenCalledTimes(2);
  });

  it('does not steal focus or scroll on re-render while already shown', () => {
    render(true);
    host.querySelector<HTMLButtonElement>('button[type="submit"]')!.focus();
    render(true);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(document.activeElement?.textContent).toBe('submit');
  });
});
