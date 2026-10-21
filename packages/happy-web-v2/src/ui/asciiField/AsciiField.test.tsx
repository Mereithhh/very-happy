// @vitest-environment happy-dom
/**
 * B-720 — the AsciiField wrapper: off (Settings → Appearance → 背景动效) renders
 * nothing and never loads the engine; on, the engine loads only after the idle
 * deferral and is stopped on unmount.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AsciiField } from './AsciiField';
import { ASCII_MOTION_STORAGE, resetAsciiMotionForTests, setAsciiMotion } from './asciiMotionPreference';

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  resetAsciiMotionForTests();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

function engineDouble() {
  const stop = vi.fn();
  const startAsciiField = vi.fn((_host: HTMLElement, _options: { preset: string; mark?: boolean }) => ({ tier: 'full' as const, layers: 3, stats: { frames: 0, lastMs: 0, avgMs: 0, maxMs: 0, layerRefreshes: 0, rows: 0, resizes: 0 }, running: () => true, reducedMotion: () => false, stop }));
  const loadEngine = vi.fn(async () => ({ startAsciiField }));
  let run: (() => void) | null = null;
  const defer = vi.fn((fn: () => void) => { run = fn; return () => { run = null; }; });
  return { stop, startAsciiField, loadEngine, defer, flushIdle: async () => { await act(async () => { run?.(); await Promise.resolve(); }); } };
}

describe('B-720 AsciiField wrapper', () => {
  it('is on by default: loads the engine only after the idle deferral, and stops it on unmount', async () => {
    const e = engineDouble();
    act(() => root.render(<AsciiField preset="hero" mark loadEngine={e.loadEngine} defer={e.defer} />));
    const el = host.querySelector('[data-ascii-field="hero"]');
    expect(el?.getAttribute('aria-hidden')).toBe('true');
    expect(e.loadEngine).not.toHaveBeenCalled();
    await e.flushIdle();
    expect(e.startAsciiField).toHaveBeenCalledTimes(1);
    expect(e.startAsciiField.mock.calls[0][1]).toMatchObject({ preset: 'hero', mark: true });
    act(() => root.unmount());
    expect(e.stop).toHaveBeenCalledTimes(1);
    root = createRoot(host);
  });

  it('switched off: renders nothing and never loads the engine', async () => {
    localStorage.setItem(ASCII_MOTION_STORAGE, 'off');
    resetAsciiMotionForTests();
    const e = engineDouble();
    act(() => root.render(<AsciiField preset="empty" loadEngine={e.loadEngine} defer={e.defer} />));
    expect(host.querySelector('[data-ascii-field]')).toBeNull();
    expect(host.querySelector('canvas')).toBeNull();
    await e.flushIdle();
    expect(e.defer).not.toHaveBeenCalled();
    expect(e.loadEngine).not.toHaveBeenCalled();
  });

  it('turning the switch off live stops a running field and removes it; on again restarts it', async () => {
    const e = engineDouble();
    act(() => root.render(<AsciiField preset="band" loadEngine={e.loadEngine} defer={e.defer} />));
    await e.flushIdle();
    expect(e.startAsciiField).toHaveBeenCalledTimes(1);
    act(() => setAsciiMotion(false));
    expect(e.stop).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[data-ascii-field]')).toBeNull();
    expect(localStorage.getItem(ASCII_MOTION_STORAGE)).toBe('off');
    act(() => setAsciiMotion(true));
    expect(localStorage.getItem(ASCII_MOTION_STORAGE)).toBeNull();
    await e.flushIdle();
    expect(e.startAsciiField).toHaveBeenCalledTimes(2);
  });

  it('a unmount before the idle callback never starts the engine', async () => {
    const e = engineDouble();
    act(() => root.render(<AsciiField preset="faint" loadEngine={e.loadEngine} defer={e.defer} />));
    act(() => root.render(<></>));
    await e.flushIdle();
    expect(e.startAsciiField).not.toHaveBeenCalled();
  });
});
