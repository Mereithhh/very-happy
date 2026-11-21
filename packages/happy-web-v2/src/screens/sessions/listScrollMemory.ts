/**
 * B-946 (Owner 11-21): on a phone the list IS the sidebar, and opening a
 * conversation unmounts it (single-pane shell) — coming back landed on a list
 * scrolled to the top. Remember where the list was, and which row was opened,
 * so the return can put both back: the offset, and that row in view even if
 * the live order moved it (recent sort, a new message elsewhere).
 *
 * sessionStorage, not memory: a reload of the list keeps its place too, and a
 * new tab still starts at the top. Best-effort — private mode / blocked
 * storage falls back to in-memory and the list simply starts at the top.
 */
const KEY = 'vh.listScroll';

export interface ListScroll {
  /** the scroller's offset when we left it */
  top: number;
  /** row key the user opened last, for "the row that was opened is visible" */
  rowKey: string | null;
}

const MAX_TOP = 10_000_000;

export function parseListScroll(raw: string | null): ListScroll | null {
  if (!raw) return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const { top, rowKey } = v as { top?: unknown; rowKey?: unknown };
  if (typeof top !== 'number' || !Number.isFinite(top) || top < 0 || top > MAX_TOP) return null;
  return { top: Math.round(top), rowKey: typeof rowKey === 'string' && rowKey ? rowKey : null };
}

let memory: ListScroll | null = null;
let loaded = false;

function read(): ListScroll | null {
  if (loaded) return memory;
  loaded = true;
  try {
    memory = parseListScroll(typeof sessionStorage === 'undefined' ? null : sessionStorage.getItem(KEY));
  } catch {
    memory = null;
  }
  return memory;
}

export function getListScroll(): ListScroll | null {
  return read();
}

export function rememberListScroll(next: ListScroll): void {
  memory = { top: Math.max(0, Math.round(next.top)), rowKey: next.rowKey ?? null };
  loaded = true;
  try {
    sessionStorage.setItem(KEY, JSON.stringify(memory));
  } catch {
    /* private mode — the in-memory copy is still used for this document */
  }
}

/** The offset stays as it was: this only says "this is the row the user opened". */
export function rememberOpenedRow(rowKey: string): void {
  const cur = read();
  if (cur?.rowKey === rowKey) return;
  rememberListScroll({ top: cur?.top ?? 0, rowKey });
}

/**
 * Where the scroller should sit when the list comes back. The remembered
 * offset wins when the opened row is still inside it; otherwise the row is
 * put at the nearest edge (its own height may exceed the viewport — then its
 * top is what matters). `contentRowTop` is the row's position inside the
 * scroll content; `null` when that row is gone.
 */
export function restoredScrollTop(input: {
  top: number;
  containerHeight: number;
  contentRowTop: number | null;
  rowHeight?: number;
  margin?: number;
}): number {
  const base = Math.max(0, Math.round(input.top));
  if (input.contentRowTop === null || input.containerHeight <= 0) return base;
  const margin = input.margin ?? 8;
  const rowHeight = input.rowHeight ?? 0;
  const visibleTop = input.contentRowTop - base;
  const visibleBottom = visibleTop + rowHeight;
  if (visibleTop >= 0 && visibleBottom <= input.containerHeight) return base;
  const target = visibleTop < 0
    ? input.contentRowTop - margin
    : input.contentRowTop + rowHeight - input.containerHeight + margin;
  return Math.max(0, Math.round(target));
}

/** test-only: forget the cached state */
export function resetListScrollForTest(): void {
  memory = null;
  loaded = false;
}
