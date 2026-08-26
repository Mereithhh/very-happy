export interface WorkspaceRowLike {
  key: string;
  machineId?: string;
  machineName?: string;
  workspacePath?: string;
  sessionId?: string;
}

export interface SidebarWorkspaceGroup<T extends WorkspaceRowLike> {
  key: string;
  name: string | null;
  path: string | null;
  machineId: string | null;
  machineName: string | null;
  representativeSessionId: string | null;
  rows: T[];
}

export type SidebarGroupMode = 'none' | 'workspace' | 'tag';

export function resolveSidebarGroupMode(saved: SidebarGroupMode, legacyGroupByTag: boolean): SidebarGroupMode {
  return legacyGroupByTag ? 'tag' : saved;
}

/** Normalize only separators and redundant trailing slashes. We deliberately
 * do not resolve `..`: cwd comes from the daemon/session metadata and changing
 * its meaning in the browser could merge two distinct server-side scopes. */
export function normalizeWorkspacePath(value: string | null | undefined): string | null {
  if (!value) return null;
  let path = value.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  if (/^[A-Za-z]:\//.test(path)) path = `${path[0].toLowerCase()}${path.slice(1)}`;
  if (path.length > 1 && !/^[a-z]:\/$/i.test(path)) path = path.replace(/\/+$/, '');
  return path || null;
}

export function workspaceBasename(path: string | null): string | null {
  if (!path) return null;
  if (path === '/') return '/';
  if (/^[a-z]:\/$/i.test(path)) return path.toUpperCase();
  return path.slice(path.lastIndexOf('/') + 1) || path;
}

/** Groups an already-ordered list. First appearance controls both group order
 * and row order, so changing the grouping lens never rewrites manual order. */
export function groupRowsByWorkspace<T extends WorkspaceRowLike>(rows: T[]): SidebarWorkspaceGroup<T>[] {
  const groups = new Map<string, SidebarWorkspaceGroup<T>>();
  for (const row of rows) {
    const machineId = row.machineId || null;
    const path = normalizeWorkspacePath(row.workspacePath);
    // Rows with neither scope component must not collapse into one invented
    // workspace. A known machine with no cwd may safely share "unassigned".
    const key = machineId
      ? `${machineId.length}:${machineId}${path === null ? ':?' : `:${path}`}`
      : `row:${row.key}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        name: workspaceBasename(path),
        path,
        machineId,
        machineName: row.machineName || null,
        representativeSessionId: row.sessionId || null,
        rows: [],
      };
      groups.set(key, group);
    }
    group.rows.push(row);
    if (!group.machineName && row.machineName) group.machineName = row.machineName;
    if (!group.representativeSessionId && row.sessionId) {
      group.representativeSessionId = row.sessionId;
    }
  }
  return [...groups.values()];
}
