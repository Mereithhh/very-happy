/**
 * B-715 — release-notes read state shared by the pager (ChangelogNotice) and the
 * sidebar entry (MajorUpdateEntry), so finishing a page updates both at once.
 * Browser-local like the B-315 receipt it extends; other tabs follow through
 * the `storage` event.
 */
import { useMemo, useSyncExternalStore } from 'react';
import { CHANGELOG_STORAGE_KEY, changelogSeenValue, type ChangelogRelease } from './changelogRelease';
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

/** One page finished: its releases are read even if the person never reaches the end. */
export function markChangelogReleasesRead(ids: readonly string[]): void {
  save(markChangelogRead(current(), ids));
}

/** Everything up to the newest release is read (last page, or leaving through a link). */
export function acknowledgeAllChangelog(): void {
  save({ seen: changelogSeenValue(), read: [] });
}

/** Unread releases, newest first; re-renders on every read change. */
export function usePendingChangelog(): ChangelogRelease[] {
  const snapshot = useSyncExternalStore(subscribe, current, current);
  return useMemo(() => pendingChangelogReleases(snapshot), [snapshot]);
}

// --- "open the notes now" requests (the sidebar entry) -----------------------

const openListeners = new Set<() => void>();

export function requestChangelogOpen(): void {
  for (const l of openListeners) l();
}

export function onChangelogOpenRequest(listener: () => void): () => void {
  openListeners.add(listener);
  return () => { openListeners.delete(listener); };
}

/** test-only */
export function resetChangelogReadStoreForTest(): void {
  state = null;
  for (const l of listeners) l();
}
