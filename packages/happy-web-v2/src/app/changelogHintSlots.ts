/**
 * B-976 — where the 「有 N 条更新说明」 bar (ChangelogHintBar) goes. It is a row in
 * the layout, never a layer over it: screens leave an empty slot
 * (ChangelogHintSlot) and the bar renders into the first one that is on screen,
 * in this order —
 *   sidebar  just above the sidebar's own 「更新说明」 row, which steps aside for
 *            it (desktop, and the phone's list screen);
 *   session  right under the session title bar, pushing the conversation down
 *            (phones inside a session, or a desktop with the sidebar folded).
 * No slot on screen (a phone on another page): the bar waits; the notes stay unread.
 * Pure store, no React components, so Sidebar / SessionDetailScreen can import it cheaply.
 */
import { useSyncExternalStore } from 'react';

export type ChangelogHintSlotKind = 'sidebar' | 'session';
export const CHANGELOG_HINT_SLOT_ORDER: readonly ChangelogHintSlotKind[] = ['sidebar', 'session'];

const slots = new Map<ChangelogHintSlotKind, HTMLElement>();
let version = 0;
let shownIn: ChangelogHintSlotKind | null = null;
const listeners = new Set<() => void>();
const notify = () => { for (const l of listeners) l(); };
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function registerChangelogHintSlot(kind: ChangelogHintSlotKind, el: HTMLElement): () => void {
  slots.set(kind, el);
  version += 1;
  notify();
  return () => {
    if (slots.get(kind) !== el) return;
    slots.delete(kind);
    version += 1;
    notify();
  };
}

/** On screen: its container has a box inside the viewport (a closed drawer sits off to the left). */
function defaultVisible(el: HTMLElement): boolean {
  if (!el.isConnected) return false;
  const box = (el.parentElement ?? el).getBoundingClientRect();
  return box.width > 0 && box.height > 0 && box.right > 0 && box.left < window.innerWidth;
}
let isVisible = defaultVisible;

/** Pure: the first slot in order that is on screen. */
export function pickChangelogHintSlot<T>(
  available: ReadonlyMap<ChangelogHintSlotKind, T>,
  visible: (slot: T) => boolean,
): { kind: ChangelogHintSlotKind; slot: T } | null {
  for (const kind of CHANGELOG_HINT_SLOT_ORDER) {
    const slot = available.get(kind);
    if (slot && visible(slot)) return { kind, slot };
  }
  return null;
}

export function currentChangelogHintSlot(): { kind: ChangelogHintSlotKind; slot: HTMLElement } | null {
  return pickChangelogHintSlot(slots, isVisible);
}

/** Changes whenever a slot comes or goes. */
export function useChangelogHintSlotsVersion(): number {
  return useSyncExternalStore(subscribe, () => version, () => version);
}

/** Where the bar is showing right now (the sidebar row hides while it is in the sidebar). */
export function setChangelogHintShownIn(kind: ChangelogHintSlotKind | null): void {
  if (shownIn === kind) return;
  shownIn = kind;
  notify();
}

export function useChangelogHintShownIn(): ChangelogHintSlotKind | null {
  return useSyncExternalStore(subscribe, () => shownIn, () => shownIn);
}

/** test-only: jsdom-like environments have no layout. */
export function setChangelogHintSlotVisibilityForTest(fn: ((el: HTMLElement) => boolean) | null): void {
  isVisible = fn ?? defaultVisible;
}
