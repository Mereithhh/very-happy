/**
 * B-588 — sidebar session preview ("peek"): what the read-only popover says,
 * and when hover may open it. Pure (no React / stores) so it is unit-tested.
 * Spec: specs/2026-10-small-ux-polish.md §2.
 *
 * Rules (design-language §6 「悬停显示富内容」): hover opens only on a fine,
 * hover-capable pointer after a delay and closes on leave; the popover holds
 * no primary action; touch opens it from the row menu instead.
 */
import type { Session } from '@/sync/storageTypes';
import { formatPathRelativeToHome } from '@/utils/sessionUtils';
import { compactResolvedModelCode } from '@/components/modelModeOptions';

export const PEEK_HOVER_DELAY_MS = 600;
export const PEEK_HOVER_MEDIA = '(hover: hover) and (pointer: fine)';
/** Branch lookups are cached per session for this long (one RPC per hover at most). */
export const PEEK_BRANCH_TTL_MS = 60_000;

export interface PeekFacts {
  machine?: string;
  path?: string;
  /** model actually running (CLI-reported), else the last usage record's model */
  model?: string;
  /** pending permission requests / questions */
  pending: number;
  /** B-586: worktree sessions report their branch in metadata (preferred over the RPC lookup) */
  branch?: string;
}

export function peekFacts(session: Session): PeekFacts {
  const meta = session.metadata;
  const running = meta?.currentModelCode || session.latestUsage?.model;
  return {
    machine: meta?.host?.trim() || undefined,
    path: meta?.path ? formatPathRelativeToHome(meta.path, meta.homeDir) : undefined,
    model: running ? compactResolvedModelCode(running) : undefined,
    pending: Object.keys(session.agentState?.requests ?? {}).length,
    ...(typeof meta?.worktree?.branch === 'string' && meta.worktree.branch ? { branch: meta.worktree.branch } : {}),
  };
}

/** `git rev-parse --abbrev-ref HEAD` stdout → branch, or undefined when not useful. */
export function parseBranch(stdout: string): string | undefined {
  const line = stdout.split('\n').map((l) => l.trim()).find(Boolean);
  if (!line || line === 'HEAD' || line.length > 200) return undefined;
  return line;
}

type BranchEntry = { at: number; branch?: string; pending?: Promise<string | undefined> };
const branchCache = new Map<string, BranchEntry>();

/**
 * Current branch of a session's working directory via the existing `bash`
 * session RPC. Only for active sessions (an offline wrapper cannot answer);
 * failures resolve undefined and are cached like successes, so sweeping the
 * pointer across the sidebar never fans out RPCs.
 */
export function lookupBranch(
  sessionId: string,
  opts: { active: boolean; path?: string; now?: number },
  run: (cwd: string) => Promise<{ success: boolean; exitCode: number; stdout: string }>,
): Promise<string | undefined> {
  if (!opts.active || !opts.path) return Promise.resolve(undefined);
  const now = opts.now ?? Date.now();
  const hit = branchCache.get(sessionId);
  if (hit?.pending) return hit.pending;
  if (hit && now - hit.at < PEEK_BRANCH_TTL_MS) return Promise.resolve(hit.branch);
  const pending = run(opts.path)
    .then((r) => (r.success && r.exitCode === 0 ? parseBranch(r.stdout) : undefined))
    .catch(() => undefined)
    .then((branch) => {
      branchCache.set(sessionId, { at: Date.now(), branch });
      return branch;
    });
  branchCache.set(sessionId, { at: now, pending });
  return pending;
}

/** Cached branch without a lookup (renders instantly on re-open). */
export function cachedBranch(sessionId: string): string | undefined {
  return branchCache.get(sessionId)?.branch;
}

/** Test-only. */
export function resetBranchCache(): void {
  branchCache.clear();
}

/**
 * Hover-mode placement (no Radix popper there, see SessionPeek): right of the
 * row, top-aligned, clamped into the viewport; left of it when the right side
 * has no room.
 */
export function placeHoverPeek(
  row: { left: number; top: number; width: number; height: number },
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  gap = 8,
  margin = 12,
): { left: number; top: number } {
  const right = row.left + row.width + gap;
  const left = right + size.width <= viewport.width - margin ? right : Math.max(margin, row.left - gap - size.width);
  const top = Math.min(Math.max(row.top, margin), Math.max(margin, viewport.height - margin - size.height));
  return { left, top };
}
