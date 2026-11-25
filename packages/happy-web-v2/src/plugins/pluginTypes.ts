/**
 * B-974d: the Web's view of the plugin v1 contract. Every shape comes from
 * `@slopus/happy-wire` (B-974a, DESIGN B-973 §5.8 r1–r5); this file only
 * re-exports them under the names the Web uses and adds two grant helpers.
 */
import { isPluginInstallActive, PLUGIN_PERMISSIONS, type PluginPermission, type PluginWidgetTone, type PluginWidgetView } from '@slopus/happy-wire';

export { PLUGIN_PERMISSIONS };
export type {
  PluginAuditEntry,
  PluginAuditListResponse as PluginAudit,
  PluginBadge,
  PluginInstallDetail,
  PluginInstallState,
  PluginInstallView,
  PluginManifest,
  PluginPendingDiff,
  PluginPermission,
  PluginWidgetView,
} from '@slopus/happy-wire';

export type WidgetTone = PluginWidgetTone;
export type PluginWidgetAction = PluginWidgetView['actions'][number];

/** States in which the plugin's runtime surfaces are live (update_pending keeps the old grants, §3.3). */
export function isLiveState(state: string): boolean {
  return isPluginInstallActive(state);
}

export function isKnownPermission(p: unknown): p is PluginPermission {
  return typeof p === 'string' && (PLUGIN_PERMISSIONS as readonly string[]).includes(p);
}

/** Known permissions of a wire string list, in canonical order. */
export function knownPermissions(list: readonly string[] | null | undefined): PluginPermission[] {
  return PLUGIN_PERMISSIONS.filter((p) => !!list?.includes(p));
}

export function hasGrant(install: { state: string; grants: readonly string[] } | null | undefined, permission: PluginPermission): boolean {
  if (!install || !isLiveState(install.state)) return false;
  return install.grants.includes(permission);
}
