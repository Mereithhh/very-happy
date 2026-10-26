/**
 * B-697 / B-830 — page-blocking overlays take turns.
 *
 * A Radix modal (the release notes, ChangelogNotice) sets
 * `body { pointer-events: none }`, traps focus and marks the rest of the page
 * `aria-hidden`; a native `<dialog>` opened with `showModal()` (TeamDialog,
 * e.g. a `?task=` deep link) goes to the top layer above it but inherits the
 * disabled pointer events. Two of them at once leave the one drawn on top
 * unclickable — B-697 (task dialog + notes: only Esc got out), B-830 (「登录已失效」
 * drawn above the notes, while only the notes' 「下一条」 reacted), B-831
 * (a Modal.alert left under the notes' backdrop until the notes closed).
 *
 * The rule — every overlay that opens on its own or blocks the page asks for a
 * turn here, and only the holder renders:
 *   critical    (3) the app cannot go on without an answer — the sign-in
 *                   expiry / confirmation dialog (AuthExpiredNotice).
 *   interaction (2) a dialog the person asked for or must answer (TeamDialog
 *                   deep link, Modal.alert / confirm / prompt, ⌘K palette,
 *                   session search, ⌘P quick open, pushed file preview).
 *   notice      (1) something the app raised on its own (release notes).
 * Higher priority pre-empts lower: the lower one closes without being marked
 * read / dismissed and comes back when the higher one is gone (for `critical`
 * that means after a reload or the next sign-in). Equal priority: the newest
 * wins — a confirm raised from (or over) a TeamDialog stacks on top, the
 * dialog hides and comes back once it is answered (B-831; first-come would
 * leave that confirm pending out of sight behind the dialog that awaits it).
 * Floating cards that are not exclusive overlays themselves (install /
 * notification invitations, notice level) stand down while anything above
 * `notice` holds the turn (`useOverlayHeldAbove`).
 * A new auto-opening or page-blocking overlay must use `useOverlayTurn` with
 * one of these priorities instead of picking a z-index above the others.
 */
import { useEffect, useState, useSyncExternalStore } from 'react';

export const OVERLAY_PRIORITY = { notice: 1, interaction: 2, critical: 3 } as const;
export type OverlayPriority = (typeof OVERLAY_PRIORITY)[keyof typeof OVERLAY_PRIORITY];

export interface OverlayRequest { id: string; priority: number; seq: number }

/** The request whose turn it is: highest priority, then newest. Pure. */
export function overlayHolder(requests: readonly OverlayRequest[]): string | null {
  return holderOf(requests)?.id ?? null;
}

function holderOf(requests: readonly OverlayRequest[]): OverlayRequest | null {
  let best: OverlayRequest | null = null;
  for (const r of requests) {
    if (!best || r.priority > best.priority || (r.priority === best.priority && r.seq > best.seq)) best = r;
  }
  return best;
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

/** True while the turn is held by an overlay ranked above `priority`. Pure. */
export function overlayHeldAbove(priority: number, list: readonly OverlayRequest[] = requests): boolean {
  return (holderOf(list)?.priority ?? 0) > priority;
}

/**
 * B-830 / B-831: non-exclusive layers (the install / notification cards,
 * `notice` level) stand down while this is true — hidden, not dismissed,
 * back afterwards.
 */
export function useOverlayHeldAbove(priority: OverlayPriority): boolean {
  const snapshot = () => overlayHeldAbove(priority);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** test-only */
export function resetOverlayQueueForTest(): void {
  requests = [];
  seq = 0;
  notify();
}
