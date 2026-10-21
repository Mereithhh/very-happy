/**
 * B-720 — 背景动效 (background motion): a device-local on/off for every
 * AsciiField. Like the chat text size (chatTextSize.ts) it is a trait of the
 * device (battery, GPU, taste on a phone vs a desktop), so it is its own
 * localStorage key, not synced settings — no zod default, nothing uploaded.
 * Absent = on (the default); only "off" is stored.
 */
import { useSyncExternalStore } from 'react';

export const ASCII_MOTION_STORAGE = 'vh-ascii-motion';

export function readAsciiMotion(): boolean {
  try {
    return localStorage.getItem(ASCII_MOTION_STORAGE) !== 'off';
  } catch {
    return true;
  }
}

const listeners = new Set<() => void>();
let current: boolean | null = null;

function snapshot(): boolean {
  if (current === null) current = readAsciiMotion();
  return current;
}

export function setAsciiMotion(enabled: boolean): void {
  current = enabled;
  try {
    if (enabled) localStorage.removeItem(ASCII_MOTION_STORAGE);
    else localStorage.setItem(ASCII_MOTION_STORAGE, 'off');
  } catch { /* private mode: still applies for this page */ }
  listeners.forEach((fn) => fn());
}

let installed = false;
function subscribe(fn: () => void): () => void {
  if (!installed && typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    installed = true;
    // Follow the switch flipped in another tab.
    window.addEventListener('storage', (event: StorageEvent) => {
      if (event.key !== null && event.key !== ASCII_MOTION_STORAGE) return;
      current = readAsciiMotion();
      listeners.forEach((l) => l());
    });
  }
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useAsciiMotion(): [boolean, (enabled: boolean) => void] {
  const enabled = useSyncExternalStore(subscribe, snapshot, () => true);
  return [enabled, setAsciiMotion];
}

/** Test hook: forget the cached value so the next read hits storage. */
export function resetAsciiMotionForTests(): void {
  current = null;
}
