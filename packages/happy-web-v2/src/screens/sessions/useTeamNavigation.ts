import { useSyncExternalStore } from 'react';
import type { TeamState } from '@slopus/happy-wire';
import { getCurrentAuth } from '@/auth/AuthContext';
import { sync } from '@/sync/sync';
import { listTeams } from '@/sync/teams';
import { getServerUrl } from '@/sync/serverConfig';

const empty: TeamState[] = [];
let snapshot: TeamState[] = empty;
let owner = '';
let pending: Promise<void> | null = null;
const listeners = new Set<() => void>();
function notify() { for (const listener of listeners) listener(); }
/** Shared read-only snapshot. Team mutations can explicitly refresh it. */
export function refreshTeamNavigation(): Promise<void> {
  const token = getCurrentAuth()?.credentials?.token;
  const key = token ? `${getServerUrl()}\0${token}` : '';
  if (key !== owner) { owner = key; snapshot = empty; pending = null; notify(); }
  if (!key) return Promise.resolve();
  if (pending) return pending;
  const request = listTeams().then(({ teams }) => {
    if (owner === key) { snapshot = teams; notify(); }
  }).catch(() => {
    // Failed reads must restore the ordinary list, not hide sessions using stale membership.
    if (owner === key) { snapshot = empty; notify(); }
  }).finally(() => { if (pending === request) pending = null; });
  pending = request;
  return request;
}
let unsubscribeResume: (() => void) | undefined;
let timer: ReturnType<typeof setInterval> | undefined;
function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!timer) {
    void refreshTeamNavigation();
    unsubscribeResume = sync.onResume(() => { void refreshTeamNavigation(); });
    timer = setInterval(() => { if (!document.hidden) void refreshTeamNavigation(); }, 15_000);
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size && timer) { clearInterval(timer); timer = undefined; unsubscribeResume?.(); unsubscribeResume = undefined; }
  };
}
function getSnapshot() {
  const token = getCurrentAuth()?.credentials?.token;
  return token && owner === `${getServerUrl()}\0${token}` ? snapshot : empty;
}
export function useTeamNavigation() {
  return useSyncExternalStore(subscribe, getSnapshot, () => empty);
}
