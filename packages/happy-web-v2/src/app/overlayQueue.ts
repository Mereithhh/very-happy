/**
 * B-697 — page-blocking overlays take turns.
 *
 * A Radix modal (the release notes, ChangelogNotice) sets
 * `body { pointer-events: none }` and traps focus; a native `<dialog>` opened
 * with `showModal()` (TeamDialog, e.g. a `?task=` deep link) goes to the top
 * layer above it but inherits the disabled pointer events. Both showing at
 * once left the whole page unclickable — only Esc got out.
 *
 * Every blocking overlay asks for a turn; only the holder renders. A dialog
 * the person asked for (`interaction`) outranks a notice the app raised on
 * its own (`notice`) and pre-empts it — the notice closes without being marked
 * read and comes back when the dialog closes. Equal priority: first come.
 */
import { useEffect, useState, useSyncExternalStore } from 'react';

export const OVERLAY_PRIORITY = { notice: 1, interaction: 2 } as const;
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

/** test-only */
export function resetOverlayQueueForTest(): void {
  requests = [];
  seq = 0;
  notify();
}
