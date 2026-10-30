import type { PermissionMode } from '@/api/types';

/**
 * Valid Codex permission modes from remote messages. Matches the modes the web
 * exposes for Codex sessions (getCodexPermissionModes). Anything outside this
 * set is ignored — a crafted value must not fall through to an
 * attacker-chosen sandbox scope (issue #1092).
 */
export const CODEX_REMOTE_PERMISSION_MODES: readonly PermissionMode[] = [
    'default',
    'read-only',
    'safe-yolo',
    'yolo',
];

/**
 * B-845: the mode a Codex wrapper publishes as `metadata.permissionMode`.
 *
 * A resumed wrapper starts from its `--permission-mode` flag only, and the
 * daemon's resume (`send --resume`, automation wake) takes that flag from the
 * published mode (B-696). Codex never published one, so every resume ran
 * `default` and the next tool call sat on an approval nobody asked for.
 *
 * Only user intent is published — an explicit `--permission-mode` or a
 * message's `meta.permissionMode` — never the code default: a legacy session
 * resumed without a flag must not overwrite the web's own pick with
 * `default` (the web adopts a newly published mode as truth).
 */
export function codexPublishablePermissionMode(mode: unknown): PermissionMode | null {
    return typeof mode === 'string' && (CODEX_REMOTE_PERMISSION_MODES as readonly string[]).includes(mode)
        ? mode as PermissionMode
        : null;
}
