/**
 * B-715 — release-notes read state shared by the pager (ChangelogNotice) and the
 * sidebar entry (MajorUpdateEntry), so finishing a page updates both at once.
 * Browser-local like the B-315 receipt it extends; other tabs follow through
 * the `storage` event.
 */
import { useMemo, useSyncExternalStore } from 'react';
import { getServerFeatures, useServerFeatures } from '@/sync/serverFeatures';
import { CHANGELOG_STORAGE_KEY, type ChangelogRelease } from './changelogRelease';
import { CHANGELOG_READ_KEY, markChangelogRead, parseChangelogRead, pendingChangelogReleases, type ChangelogReadState } from './changelogPager';

function load(): ChangelogReadState {
  try {
    return { seen: localStorage.getItem(CHANGELOG_STORAGE_KEY), read: parseChangelogRead(localStorage.getItem(CHANGELOG_READ_KEY)) };
  } catch {
    return { seen: null, read: [] };
  }
}

let state: ChangelogReadState | null = null;
const listeners = new Set<() => void>();
const current = () => (state ??= load());

function save(next: ChangelogReadState): void {
  state = next;
  try {
    if (next.seen) localStorage.setItem(CHANGELOG_STORAGE_KEY, next.seen);
    if (next.read.length > 0) localStorage.setItem(CHANGELOG_READ_KEY, JSON.stringify(next.read));
    else localStorage.removeItem(CHANGELOG_READ_KEY);
  } catch { /* private mode: this tab still remembers */ }
  for (const l of listeners) l();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  const onStorage = (e: StorageEvent) => {
    if (e.key !== CHANGELOG_STORAGE_KEY && e.key !== CHANGELOG_READ_KEY && e.key !== null) return;
    state = load();
    listener();
  };
  window.addEventListener('storage', onStorage);
  return () => { listeners.delete(listener); window.removeEventListener('storage', onStorage); };
}

export function changelogReadState(): ChangelogReadState {
  return current();
}

/**
 * Releases the person was shown (a finished page, the last page, leaving through
 * a link). By id, not "everything up to the newest": an entry that was hidden
 * (B-974g) or arrived while the notes were open stays unread.
 */
export function markChangelogReleasesRead(ids: readonly string[]): void {
  save(markChangelogRead(current(), ids, undefined, getServerFeatures()));
}

/** Unread releases right now, newest first. */
export function currentPendingChangelog(): ChangelogRelease[] {
  return pendingChangelogReleases(current(), undefined, getServerFeatures());
}

/** Unread releases, newest first; re-renders on every read or feature change. */
export function usePendingChangelog(): ChangelogRelease[] {
  const snapshot = useSyncExternalStore(subscribe, current, current);
  const features = useServerFeatures();
  return useMemo(() => pendingChangelogReleases(snapshot, undefined, features), [snapshot, features]);
}

// --- the notes open / closed during this visit (B-857) -----------------------

/** Whether the notes are open (or waiting for their overlay turn), and when they last closed in this visit. */
export interface ChangelogVisit {
  open: boolean;
  closedAt: number | null;
}

const NO_VISIT: ChangelogVisit = { open: false, closedAt: null };
let visit = NO_VISIT;
const visitListeners = new Set<() => void>();

function setVisit(next: ChangelogVisit): void {
  visit = next;
  for (const l of visitListeners) l();
}

/** B-857b: the notes opened (again) — a later `notice` keeps waiting until they close. */
export function noteChangelogOpened(): void {
  setVisit({ ...visit, open: true });
}

/**
 * The notes dialog was open and has closed — read to the end, closed on the
 * last page, or left through a link. Lets a later `notice` (the feedback card)
 * queue behind the notes instead of skipping the visit. Per page load.
 */
export function noteChangelogClosed(now = Date.now()): void {
  setVisit({ open: false, closedAt: now });
}

/** When the notes last closed in this visit; null = not (yet) shown and closed. */
export function changelogClosedAt(): number | null {
  return visit.closedAt;
}

export function changelogVisit(): ChangelogVisit {
  return visit;
}

function subscribeVisit(listener: () => void) {
  visitListeners.add(listener);
  return () => { visitListeners.delete(listener); };
}

export function useChangelogVisit(): ChangelogVisit {
  return useSyncExternalStore(subscribeVisit, changelogVisit, changelogVisit);
}

/**
 * B-950: the notes surfaced on their own (opened, or left the 「有 N 条更新说明」
 * toast) once in this page load. The notice is mounted under both route gates,
 * so going list → session → list remounts it; without this every remount left
 * another toast (two on screen at once on phones).
 */
let autoShown = false;
export function changelogAutoShownThisVisit(): boolean {
  return autoShown;
}
export function noteChangelogAutoShown(): void {
  autoShown = true;
}

/**
 * B-976: ids this page load has already put in front of the person (pager or
 * bar). An unread entry outside this set — it arrived later — still has to
 * surface, without a reload and without opening the pager a second time.
 */
let surfaced = new Set<string>();
export function noteChangelogSurfaced(): void {
  for (const release of currentPendingChangelog()) surfaced.add(release.id);
}
export function hasUnsurfacedChangelog(): boolean {
  return currentPendingChangelog().some((release) => !surfaced.has(release.id));
}

// --- the 「有 N 条更新说明」 bar (B-976) ---------------------------------------

/**
 * B-976: held back (deep link, early typing), the notes leave a bar that stays
 * until they are read — B-842's 10-second toast ran out unseen. `wanted` once
 * this visit decided on a hint; `dismissed` by its ✕ for this visit only (a
 * long stay in the background counts as a new visit, see ChangelogNotice).
 * Module state: the notice remounts on every route-gate switch (B-950).
 */
export interface ChangelogHint {
  wanted: boolean;
  dismissed: boolean;
}

const NO_HINT: ChangelogHint = { wanted: false, dismissed: false };
let hint = NO_HINT;
const hintListeners = new Set<() => void>();

function setHint(next: ChangelogHint): void {
  if (next.wanted === hint.wanted && next.dismissed === hint.dismissed) return;
  hint = next;
  for (const l of hintListeners) l();
}

export function showChangelogHint(): void {
  setHint({ ...hint, wanted: true });
}

export function dismissChangelogHint(): void {
  setHint({ ...hint, dismissed: true });
}

/** A new visit without a reload (back after a long time in the background): a closed bar may come back. */
export function reviveChangelogHint(): void {
  setHint({ ...hint, dismissed: false });
}

export function changelogHint(): ChangelogHint {
  return hint;
}

function subscribeHint(listener: () => void) {
  hintListeners.add(listener);
  return () => { hintListeners.delete(listener); };
}

export function useChangelogHint(): ChangelogHint {
  return useSyncExternalStore(subscribeHint, changelogHint, changelogHint);
}

// --- "open the notes now" requests (the sidebar entry) -----------------------

const openListeners = new Set<() => void>();
/** B-823: a request made before the (deferred, lazy) notice mounted waits for it. */
let openPending = false;

export function requestChangelogOpen(): void {
  if (openListeners.size === 0) {
    openPending = true;
    return;
  }
  for (const l of openListeners) l();
}

export function onChangelogOpenRequest(listener: () => void): () => void {
  openListeners.add(listener);
  if (openPending) {
    openPending = false;
    listener();
  }
  return () => { openListeners.delete(listener); };
}

/** test-only */
export function resetChangelogReadStoreForTest(): void {
  state = null;
  openPending = false;
  visit = NO_VISIT;
  autoShown = false;
  hint = NO_HINT;
  surfaced = new Set();
  for (const l of listeners) l();
  for (const l of visitListeners) l();
  for (const l of hintListeners) l();
}
