/**
 * Allowlist validation for the `permissionMode` spawn option (pure, unit-tested).
 *
 * The daemon forwards a client-supplied permission mode to the spawned CLI as
 * `--permission-mode <v>`. The value crosses a trust boundary (web → server →
 * daemon → child argv), so it is validated against a fixed allowlist here —
 * anything else is dropped (the caller logs and spawns without the flag).
 *
 * The list mirrors what the CLI itself accepts (see
 * `claude/utils/permissionMode.ts` VALID_PERMISSION_MODES) minus the
 * Codex-only aliases the web never sends for Claude spawns.
 */

export const ALLOWED_SPAWN_PERMISSION_MODES = [
    'default',
    'acceptEdits',
    'plan',
    'yolo',
    'bypassPermissions',
] as const;

export type SpawnPermissionMode = (typeof ALLOWED_SPAWN_PERMISSION_MODES)[number];

/**
 * Returns the mode when it is a valid allowlisted string, null otherwise
 * (including undefined/null/non-string input — absence and garbage are
 * treated the same: spawn without a `--permission-mode` flag).
 */
export function sanitizeSpawnPermissionMode(value: unknown): SpawnPermissionMode | null {
    if (typeof value !== 'string') return null;
    return (ALLOWED_SPAWN_PERMISSION_MODES as readonly string[]).includes(value)
        ? (value as SpawnPermissionMode)
        : null;
}
