/**
 * B-696: the permission mode a DAEMON-initiated relaunch (automation waking a
 * hibernated session) hands the new wrapper. Pure; unit-tested.
 *
 * A resumed wrapper starts from its `--permission-mode` flag and nothing else
 * (no flag → `default`) and then PUBLISHES that mode, which the web adopts as
 * truth — so a wake without the flag silently turned 「自动执行」 into 「默认」.
 * B-683 fixed the web restore / restart RPCs (happy-web-v2
 * `relaunchPermissionMode`); the daemon's own wake had no caller to supply it.
 *
 * The daemon has no device-local pick, so the only user intent it can see is
 * the mode the last wrapper actually ran (`metadata.permissionMode`, server
 * copy). The code default is never invented: no published mode → no flag.
 * Claude values go through the same outbound allowlist as the web
 * (`normalizeClaudeOutboundMode`: yolo → bypassPermissions, unknown →
 * default); other flavors forward their published mode as-is. The caller still
 * runs `sanitizeSpawnPermissionMode` before it reaches argv.
 */

export const CLAUDE_OUTBOUND_MODES = ['default', 'acceptEdits', 'plan', 'bypassPermissions'] as const;
export type ClaudeOutboundMode = typeof CLAUDE_OUTBOUND_MODES[number];

/** Mirror of happy-web-v2 `sync/permissionModeOutbound.ts` (B-262 A1). */
export function normalizeClaudeOutboundMode(value: string | null | undefined): ClaudeOutboundMode | null {
    if (value === null || value === undefined) return null;
    if (value === 'yolo') return 'bypassPermissions';
    return (CLAUDE_OUTBOUND_MODES as readonly string[]).includes(value) ? (value as ClaudeOutboundMode) : 'default';
}

export function publishedRelaunchPermissionMode(
    metadata: { flavor?: string; permissionMode?: unknown } | null | undefined,
): string | undefined {
    const published = typeof metadata?.permissionMode === 'string' ? metadata.permissionMode : null;
    if ((metadata?.flavor ?? 'claude') === 'claude') {
        return normalizeClaudeOutboundMode(published) ?? undefined;
    }
    return published ?? undefined;
}
