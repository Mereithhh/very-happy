/**
 * B-697 / B-830 — page-blocking overlays take turns.
 *
 * A Radix modal (the release notes, ChangelogNotice) sets
 * `body { pointer-events: none }`, traps focus and marks the rest of the page
 * `aria-hidden`; a native `<dialog>` opened with `showModal()` (TeamDialog,
 * e.g. a `?task=` deep link) goes to the top layer above it but inherits the
 * disabled pointer events. Two of them at once leave the one drawn on top
 * unclickable — B-697 (task dialog + notes: only Esc got out), B-830 (「登录已失效」
 * drawn above the notes, while only the notes' 「下一条」 reacted).
 *
 * The rule — every overlay that opens on its own or blocks the page asks for a
 * turn here, and only the holder renders:
 *   critical    (3) the app cannot go on without an answer — the sign-in
 *                   expiry / confirmation dialog (AuthExpiredNotice).
 *   interaction (2) a dialog the person asked for (TeamDialog deep link).
 *   notice      (1) something the app raised on its own (release notes).
 * Higher priority pre-empts lower: the lower one closes without being marked
 * read / dismissed and comes back when the higher one is gone (for `critical`
 * that means after a reload or the next sign-in). Equal priority: first come.
 * Floating cards and Modal.* that are not exclusive overlays themselves still
 * stand down while a critical overlay is up (`useCriticalOverlayActive`).
 * A new auto-opening or page-blocking overlay must use `useOverlayTurn` with
 * one of these priorities instead of picking a z-index above the others.
 */
import { useEffect, useState, useSyncExternalStore } from 'react';

export const OVERLAY_PRIORITY = { notice: 1, interaction: 2, critical: 3 } as const;
export type OverlayPriority = (typeof OVERLAY_PRIORITY)[keyof typeof OVERLAY_PRIORITY];

export interface OverlayRequest { id: string; priority: number; seq: number }

/** The request whose turn it is: highest priority, then earliest. Pure. */
export function overlayHolder(requests: readonly OverlayRequest[]): string | null {
  let best: OverlayRequest | null = null;
  for (const r of requests) {
    if (!best || r.priority > best.priority || (r.priority === best.priority && r.seq < best.seq)) best = r;
  }
  return best?.id ?? null;
}

let requests: OverlayRequest[] = [];
let seq = 0;
const listeners = new Set<() => void>();
const notify = () => { for (const l of listeners) l(); };

/** Ask for a turn; the returned function withdraws the request. */
export function requestOverlay(id: string, priority: number): () => void {
  requests = [...requests.filter((r) => r.id !== id), { id, priority, seq: ++seq }];
  notify();
  return () => {
    const next = requests.filter((r) => r.id !== id);
    if (next.length === requests.length) return;
    requests = next;
    notify();
  };
}

export function currentOverlay(): string | null {
  return overlayHolder(requests);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

let ids = 0;
/** True while `wanted` and it is this overlay's turn. */
export function useOverlayTurn(wanted: boolean, priority: OverlayPriority): boolean {
  const [id] = useState(() => `overlay-${++ids}`);
  useEffect(() => (wanted ? requestOverlay(id, priority) : undefined), [id, wanted, priority]);
  const holder = useSyncExternalStore(subscribe, currentOverlay, currentOverlay);
  return wanted && holder === id;
}

/** True while an overlay of `critical` priority holds the turn. Pure. */
export function criticalOverlayActive(list: readonly OverlayRequest[] = requests): boolean {
  const holder = overlayHolder(list);
  return list.some((r) => r.id === holder && r.priority >= OVERLAY_PRIORITY.critical);
}

/**
 * B-830: non-exclusive layers (Modal.*, the install / notification cards)
 * stand down while this is true — hidden, not dismissed, back afterwards.
 */
export function useCriticalOverlayActive(): boolean {
  return useSyncExternalStore(subscribe, criticalSnapshot, criticalSnapshot);
}
const criticalSnapshot = () => criticalOverlayActive();

/** test-only */
export function resetOverlayQueueForTest(): void {
  requests = [];
  seq = 0;
  notify();
}
