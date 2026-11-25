/**
 * B-974d: pure presentation rules for plugins (DESIGN B-973 §1, §3, §5.2, §5.4).
 * Risk levels, default grants, badge text and the global-badge rule come from
 * `@slopus/happy-wire`; this file only combines them for the Web.
 */
import {
  isPluginEmojiIcon,
  isPluginIconName,
  isPluginPermissionSensitive,
  PLUGIN_PERMISSION_RISK,
  pluginBadgeCountsGlobally,
  pluginBadgeText,
  pluginDefaultGrants,
  type PluginIcon,
} from '@slopus/happy-wire';
import { hasGrant, isLiveState, knownPermissions, PLUGIN_PERMISSIONS, type PluginBadge, type PluginInstallView, type PluginPermission, type PluginWidgetView } from './pluginTypes';

export type PermissionRisk = (typeof PLUGIN_PERMISSION_RISK)[PluginPermission];

export function permissionRisk(p: PluginPermission): PermissionRisk {
  return PLUGIN_PERMISSION_RISK[p];
}

export function isSensitive(p: PluginPermission): boolean {
  return isPluginPermissionSensitive(p);
}

/**
 * Initial checkboxes on the review page: the wire default (every requested
 * permission except the sensitive ones). On an update, permissions the owner
 * already granted stay checked.
 */
export function initialGrants(requested: readonly PluginPermission[], currentGrants: readonly string[] = []): PluginPermission[] {
  const defaults = new Set<string>(pluginDefaultGrants(requested));
  return requested.filter((p) => defaults.has(p) || currentGrants.includes(p));
}

/**
 * Toggling one checkbox. Checking a sensitive permission requires
 * `confirmed === true` (the second confirmation, §3.2); without it the grant
 * set is unchanged.
 */
export function toggleGrant(grants: readonly PluginPermission[], p: PluginPermission, checked: boolean, confirmed: boolean): PluginPermission[] {
  if (!checked) return grants.filter((g) => g !== p);
  if (grants.includes(p)) return [...grants];
  if (isSensitive(p) && !confirmed) return [...grants];
  return [...grants, p];
}

/** Grants sent to approve: only requested permissions, in canonical order. */
export function approvalGrants(requested: readonly PluginPermission[], grants: readonly PluginPermission[]): PluginPermission[] {
  return PLUGIN_PERMISSIONS.filter((p) => requested.includes(p) && grants.includes(p));
}

/** §5.2: `99+` above 99; null / 0 shows nothing. */
export function formatBadge(badge: Pick<PluginBadge, 'count'> | null | undefined): string | null {
  return pluginBadgeText(badge?.count ?? null);
}

/** Sidebar rows: live installs with a granted sidebar entry, in a stable order. */
export function sidebarInstalls(installs: readonly PluginInstallView[]): PluginInstallView[] {
  return installs.filter((i) => i.sidebar && hasGrant(i, 'sidebar')).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

/**
 * §11 Q5: only `tone: attention` badges count toward the global App badge
 * (wire `pluginBadgeCountsGlobally`), and only for live installs with the
 * sidebar grant.
 */
export function pluginAttentionTotal(installs: readonly PluginInstallView[]): number {
  let total = 0;
  for (const i of installs) {
    if (!hasGrant(i, 'sidebar')) continue;
    total += pluginBadgeCountsGlobally(i.badge ?? null, i.muted === true);
  }
  return total;
}

export const MAX_WIDGETS_PER_SESSION = 3;
export const MAX_WIDGET_ACTIONS = 2;

/**
 * §1 E4 / §5.4: what the session header shows. Only widgets of live installs
 * with `session.widget`, whose install lives on the session's machine, at most
 * 3 per session (oldest first so a newcomer cannot push an existing chip
 * out), each with at most 2 actions.
 */
export function visibleWidgets(
  widgets: readonly PluginWidgetView[],
  installs: readonly PluginInstallView[],
  session: { id: string; machineId: string | null | undefined; archived?: boolean },
): { widget: PluginWidgetView; install: PluginInstallView }[] {
  if (session.archived) return [];
  const byId = new Map(installs.map((i) => [i.id, i]));
  const seen = new Set<string>();
  const out: { widget: PluginWidgetView; install: PluginInstallView }[] = [];
  const sorted = [...widgets].filter((w) => w.sessionId === session.id).sort((a, b) => a.updatedAt - b.updatedAt);
  for (const w of sorted) {
    const install = byId.get(w.installId);
    if (!install || !hasGrant(install, 'session.widget')) continue;
    if (!session.machineId || install.machineId !== session.machineId) continue;
    if (seen.has(install.id)) continue;
    seen.add(install.id);
    out.push({ widget: { ...w, actions: w.actions.slice(0, MAX_WIDGET_ACTIONS) }, install });
    if (out.length >= MAX_WIDGETS_PER_SESSION) break;
  }
  return out;
}

/** Status for the settings list / review header. */
export function installStatus(i: Pick<PluginInstallView, 'state'>): 'enabled' | 'needs-review' | 'update-pending' | 'disabled' | 'rejected' | 'operator' {
  switch (i.state) {
    case 'enabled':
      return 'enabled';
    case 'pending':
      return 'needs-review';
    case 'update_pending':
      return 'update-pending';
    case 'rejected':
      return 'rejected';
    case 'disabled_by_operator':
      return 'operator';
    default:
      return 'disabled';
  }
}

export function needsReview(i: Pick<PluginInstallView, 'state'>): boolean {
  return i.state === 'pending' || i.state === 'update_pending';
}

export function canOpenPanel(i: PluginInstallView | null | undefined, panelId: string): boolean {
  return !!i && !!i.origin && hasGrant(i, 'panel') && i.panels.some((p) => p.id === panelId);
}

export { isLiveState, knownPermissions };

/** Built-in icon name (wire `PLUGIN_ICONS`) or a single emoji; anything else (URLs, SVG) falls back to puzzle. */
export function iconKind(icon: string | null | undefined): { kind: 'builtin'; name: PluginIcon } | { kind: 'emoji'; text: string } {
  if (icon && isPluginIconName(icon)) return { kind: 'builtin', name: icon };
  if (icon && isPluginEmojiIcon(icon)) return { kind: 'emoji', text: icon };
  return { kind: 'builtin', name: 'puzzle' };
}
