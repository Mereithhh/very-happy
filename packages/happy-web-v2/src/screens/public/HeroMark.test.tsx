// @vitest-environment happy-dom
/**
 * B-720 × B-724 — the hero mark is a static SVG from first render; the
 * formation enhancement loads only after idle, only with motion allowed.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HeroMark } from './HeroMark';
import { ASCII_MOTION_STORAGE, resetAsciiMotionForTests } from '@/ui/asciiField/asciiMotionPreference';

let host: HTMLElement;
let root: Root;
let reduced = false;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  resetAsciiMotionForTests();
  reduced = false;
  window.matchMedia = ((q: string) => ({ matches: q.includes('reduced-motion') ? reduced : false, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  host = document.createElement('section');
  host.className = 'pub-hero';
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

function doubles() {
  const stop = vi.fn();
  const startLogoFormation = vi.fn(() => ({ stop, done: () => false }));
  const loadFormation = vi.fn(async () => ({ startLogoFormation }) as never);
  let run: (() => void) | null = null;
  const defer = vi.fn((fn: () => void) => { run = fn; return () => { run = null; }; });
  return { stop, startLogoFormation, loadFormation, defer, idle: async () => { await act(async () => { run?.(); await Promise.resolve(); }); } };
}

describe('B-720 × B-724 HeroMark', () => {
  it('renders the static mark immediately and plays the formation after idle', async () => {
    const d = doubles();
    act(() => root.render(<HeroMark label="Very Happy" loadFormation={d.loadFormation} defer={d.defer} />));
    expect(host.querySelector('[data-hero-mark] svg[role="img"][aria-label="Very Happy"] path')?.getAttribute('fill-rule')).toBe('evenodd');
    expect(d.loadFormation).not.toHaveBeenCalled();
    await d.idle();
    expect(d.startLogoFormation).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
    expect(d.stop).toHaveBeenCalled();
    root = createRoot(host);
  });

  it('reduced motion: only the static (final) frame, no formation', async () => {
    reduced = true;
    const d = doubles();
    act(() => root.render(<HeroMark label="Very Happy" loadFormation={d.loadFormation} defer={d.defer} />));
    await d.idle();
    expect(host.querySelector('[data-hero-mark] svg')).not.toBeNull();
    expect(d.defer).not.toHaveBeenCalled();
  });

  it('background motion off: static mark, no formation', async () => {
    localStorage.setItem(ASCII_MOTION_STORAGE, 'off');
    resetAsciiMotionForTests();
    const d = doubles();
    act(() => root.render(<HeroMark label="Very Happy" loadFormation={d.loadFormation} defer={d.defer} />));
    await d.idle();
    expect(host.querySelector('[data-hero-mark] svg')).not.toBeNull();
    expect(d.defer).not.toHaveBeenCalled();
  });
});
