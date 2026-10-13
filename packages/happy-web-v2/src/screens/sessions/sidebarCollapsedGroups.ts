/**
 * B-580 — collapsible sidebar groups: device-local persisted collapse state,
 * the collapsed-header status summary, and "reveal the current row" planning.
 * Pure helpers + one tiny external store (useSyncExternalStore), so every
 * Sidebar instance agrees and the rules are unit-tested in
 * sidebarCollapsedGroups.test.ts.
 *
 * Idea after Orca `worktree-list/listing/use-collapsed-groups.ts` and
 * `navigation/worktree-reveal-group-keys.ts` (MIT); rewritten for our rows.
 * Spec: specs/2026-10-settings-search-and-sidebar-groups.md.
 */
import { useSyncExternalStore } from 'react';
import type { AgentExecution } from '@/sync/agentStatus';

export const COLLAPSED_GROUPS_STORAGE_KEY = 'vh:sidebar-collapsed-groups:v1';
/** Workspace keys churn over months; keep only the most recent choices. */
export const COLLAPSED_GROUPS_LIMIT = 200;

/** Explicit user choices only: id → collapsed. Absent = the group's default. */
export type CollapsedGroups = Record<string, boolean>;

/** 已完成（今日） starts collapsed (pre-B-580 behaviour); everything else open. */
export function defaultCollapsed(groupId: string): boolean {
  return groupId === 'completed';
}

export function isGroupCollapsed(state: CollapsedGroups, groupId: string): boolean {
  return Object.prototype.hasOwnProperty.call(state, groupId) ? state[groupId] === true : defaultCollapsed(groupId);
}

/** Set one group's state; re-inserted last so trimming drops the oldest choices. */
export function withGroupCollapsed(state: CollapsedGroups, groupId: string, collapsed: boolean): CollapsedGroups {
  if (isGroupCollapsed(state, groupId) === collapsed && Object.prototype.hasOwnProperty.call(state, groupId)) return state;
  const next: CollapsedGroups = {};
  for (const [k, v] of Object.entries(state)) if (k !== groupId) next[k] = v;
  next[groupId] = collapsed;
  const keys = Object.keys(next);
  if (keys.length <= COLLAPSED_GROUPS_LIMIT) return next;
  const trimmed: CollapsedGroups = {};
  for (const k of keys.slice(keys.length - COLLAPSED_GROUPS_LIMIT)) trimmed[k] = next[k];
  return trimmed;
}

export function parseCollapsedGroups(raw: string | null): CollapsedGroups {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: CollapsedGroups = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) if (typeof v === 'boolean') out[k] = v;
    return out;
  } catch {
    return {};
  }
}

// ── store (localStorage best-effort; private mode / quota → in-memory) ──

let memory: CollapsedGroups | null = null;
const listeners = new Set<() => void>();

function load(): CollapsedGroups {
  if (memory) return memory;
  let raw: string | null = null;
  try {
    raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(COLLAPSED_GROUPS_STORAGE_KEY);
  } catch {
    raw = null;
  }
  memory = parseCollapsedGroups(raw);
  return memory;
}

export function getCollapsedGroups(): CollapsedGroups {
  return load();
}

export function setGroupCollapsed(groupId: string, collapsed: boolean): void {
  const cur = load();
  const next = withGroupCollapsed(cur, groupId, collapsed);
  if (next === cur) return;
  memory = next;
  try {
    localStorage.setItem(COLLAPSED_GROUPS_STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* keep the in-memory state */
  }
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useCollapsedGroups(): CollapsedGroups {
  return useSyncExternalStore(subscribe, getCollapsedGroups, getCollapsedGroups);
}

/** test-only: forget the cached state */
export function resetCollapsedGroupsForTest(): void {
  memory = null;
}

/**
 * The flat VISIBLE sequence of a grouped list: folded groups contribute no
 * rows, so they take no ⌘1-9 number and no move-up/down slot — the sidebar's
 * displayRows must equal what is rendered.
 */
export function flattenOpenGroups<G extends { rows: readonly R[] }, R>(
  groups: readonly G[],
  idOf: (group: G) => string,
  state: CollapsedGroups,
): R[] {
  return groups.flatMap((g) => (isGroupCollapsed(state, idOf(g)) ? [] : [...g.rows]));
}

// ── collapsed-header summary ("折叠不隐藏关键状态") ──

export interface GroupStatusSummary {
  /** 等待操作 (permission / question / needs input) */
  input: number;
  /** 运行中 (incl. background tasks) */
  running: number;
  /** 未读 */
  unread: number;
}

/** `status` per row is the sidebar slot's signal (agentStatusSignal). */
export function summarizeGroup(statuses: Iterable<AgentExecution | 'unread' | null>): GroupStatusSummary {
  const out: GroupStatusSummary = { input: 0, running: 0, unread: 0 };
  for (const s of statuses) {
    if (s === 'input') out.input++;
    else if (s === 'running' || s === 'background') out.running++;
    else if (s === 'unread') out.unread++;
  }
  return out;
}

// ── reveal the current row ──

export interface RevealSection<K = string> {
  id: string;
  collapsible: boolean;
  /** every row of the group, including the ones hidden by collapse */
  keys: readonly K[];
}

/** The group holding the current row, and whether it must be expanded first. */
export function findRevealTarget<K>(
  sections: readonly RevealSection<K>[],
  isCurrent: (key: K) => boolean,
  collapsed: (groupId: string) => boolean,
): { sectionId: string; key: K; expand: boolean } | null {
  for (const sec of sections) {
    const key = sec.keys.find(isCurrent);
    if (key !== undefined) return { sectionId: sec.id, key, expand: sec.collapsible && collapsed(sec.id) };
  }
  return null;
}

/**
 * Nearest-edge scroll for the sidebar's OWN list (never scrollIntoView, which
 * also scrolls ancestors). Returns the new scrollTop, or null when the row is
 * already fully visible. Rects are viewport coordinates.
 */
export function nearestScrollTop(input: {
  containerTop: number;
  containerHeight: number;
  scrollTop: number;
  rowTop: number;
  rowHeight: number;
  margin?: number;
}): number | null {
  const margin = input.margin ?? 8;
  const top = input.rowTop - input.containerTop;
  const bottom = top + input.rowHeight;
  if (top >= 0 && bottom <= input.containerHeight) return null;
  if (top < 0 || input.rowHeight + margin * 2 > input.containerHeight) return Math.max(0, Math.round(input.scrollTop + top - margin));
  return Math.max(0, Math.round(input.scrollTop + bottom - input.containerHeight + margin));
}
