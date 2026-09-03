/**
 * Permission mode for ACP agents that have no mode selector (pi via pi-acp).
 *
 * pi has no permission layer of its own; the only gate is a pi extension
 * (vh-supervisor's permission-gate) that decides allow / ask / deny per tool
 * call. The ACP runner cannot switch it through ACP (pi-acp exposes no "mode"
 * config option), so the mode travels out-of-band:
 *
 *   - at spawn:   `HAPPY_PERMISSION_MODE=<mode>` in the pi-acp child env;
 *   - live switch: `<happy home>/session-modes/<happySessionId>.json`
 *                  → `{ "permissionMode": "...", "updatedAt": ms }` (0600,
 *                  atomic rename), re-read by the gate on every tool call.
 *
 * The same value is published as `session.metadata.permissionMode` so the web
 * shows what is really in effect (AGENTS.md rule 14). The file is removed when
 * the wrapper exits. The vocabulary is Claude's four modes; `yolo` is accepted
 * as an alias for `bypassPermissions` because the web/CLI mode pickers send it.
 */
import { existsSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

import { configuration } from '@/configuration';
import { writePrivateFileSync } from '@/utils/secureFiles';

export const SESSION_MODE_DIR = 'session-modes';

export type AcpPermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';

const ACP_PERMISSION_MODES: readonly AcpPermissionMode[] = ['default', 'acceptEdits', 'plan', 'bypassPermissions'];

/** Allowlisted mode or null; `yolo` maps to `bypassPermissions`, anything else is rejected. */
export function normalizeAcpPermissionMode(value: unknown): AcpPermissionMode | null {
  if (typeof value !== 'string') return null;
  if (value === 'yolo') return 'bypassPermissions';
  return ACP_PERMISSION_MODES.includes(value as AcpPermissionMode) ? (value as AcpPermissionMode) : null;
}

export interface SessionModeFilePayload {
  permissionMode: AcpPermissionMode;
  updatedAt: number;
}

export function sessionModeFilePath(happySessionId: string, dir = join(configuration.happyHomeDir, SESSION_MODE_DIR)): string {
  return join(dir, `${happySessionId}.json`);
}

export function sessionModeFilePayload(permissionMode: AcpPermissionMode, now = Date.now()): SessionModeFilePayload {
  return { permissionMode, updatedAt: now };
}

export function writeSessionModeFile(
  happySessionId: string,
  permissionMode: AcpPermissionMode,
  opts: { dir?: string; now?: number } = {},
): SessionModeFilePayload {
  const path = sessionModeFilePath(happySessionId, opts.dir);
  mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
  const payload = sessionModeFilePayload(permissionMode, opts.now);
  const tmp = `${path}.${process.pid}.tmp`;
  writePrivateFileSync(tmp, JSON.stringify(payload));
  renameSync(tmp, path);
  return payload;
}

export function removeSessionModeFile(happySessionId: string, dir?: string): void {
  const path = sessionModeFilePath(happySessionId, dir);
  if (existsSync(path)) unlinkSync(path);
}
