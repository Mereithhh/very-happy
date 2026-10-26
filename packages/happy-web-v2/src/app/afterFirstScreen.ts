/**
 * B-823 (B-816 Q5): work that is not part of the first screen waits until it
 * is up. On a mid-range phone the main thread is saturated from navigation to
 * the composer (B-816 §1.4: 51ms idle in the first 2.6s), so every dialog that
 * mounts at boot — the release notes (「版本信号」, its Radix FocusScope alone
 * forced a 94ms layout), the notification invitation — pushes the composer
 * back. They mount once the pre-paint splash has been dismissed (the first
 * screen is on display) and the browser reports an idle slot, or after
 * IDLE_TIMEOUT_MS at the latest.
 */
import { useSyncExternalStore } from 'react';

export const IDLE_TIMEOUT_MS = 1_500;

type IdleScheduler = (callback: () => void) => void;

const defaultIdle: IdleScheduler = (callback) => {
  const w = globalThis as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number };
  if (typeof w.requestIdleCallback === 'function') w.requestIdleCallback(callback, { timeout: IDLE_TIMEOUT_MS });
  else setTimeout(callback, 0);
};

let shown = false;
let settled = false;
/** The person pressed a key / pointer since this page started (trusted events only). */
let interacted = false;
if (typeof window !== 'undefined') {
  const mark = (event: Event) => {
    if (!event.isTrusted) return;
    interacted = true;
    window.removeEventListener('keydown', mark, true);
    window.removeEventListener('pointerdown', mark, true);
  };
  window.addEventListener('keydown', mark, true);
  window.addEventListener('pointerdown', mark, true);
}

/**
 * B-823: a deferred dialog that would trap focus asks this before opening on
 * its own: someone who already started typing or tapping must not have it
 * land on top of what they are doing. (Eagerly mounted, it used to be there
 * before anything was interactive.)
 */
export function userHasInteracted(): boolean {
  return interacted;
}
let idle: IdleScheduler = defaultIdle;
const listeners = new Set<() => void>();

/** The first screen is on display (the splash started fading). Idempotent. */
export function markFirstScreenShown(): void {
  if (shown) return;
  shown = true;
  idle(() => {
    settled = true;
    for (const listener of listeners) listener();
  });
}

export function isAfterFirstScreen(): boolean {
  return settled;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** false until the first screen is up and the main thread had a breather. */
export function useAfterFirstScreen(): boolean {
  return useSyncExternalStore(subscribe, isAfterFirstScreen, isAfterFirstScreen);
}

/** test-only */
export function resetAfterFirstScreenForTest(scheduler: IdleScheduler = defaultIdle, opts: { interacted?: boolean } = {}): void {
  shown = false;
  settled = false;
  interacted = opts.interacted ?? false;
  idle = scheduler;
  listeners.clear();
}
