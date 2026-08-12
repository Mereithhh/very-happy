/**
 * Log-directory pruning. ~/.happy/logs had NO retention at all — field audit
 * found 746MB / 713 files on a machine that isn't even the daemon host (a
 * single runaway daemon log was 132MB, see the missing-return fix in
 * logger.ts). The daemon sweeps once at startup: age cap first, then a total
 * size cap, always keeping the most recent files. The current process's own
 * log file is never deleted.
 *
 * planLogPrune is pure (list in, delete-list out) so the policy is
 * unit-testable without a filesystem.
 */
import { readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

export interface PrunableFile {
  path: string
  mtimeMs: number
  size: number
}

export interface LogPrunePolicy {
  maxAgeMs: number
  maxTotalBytes: number
  /** Never delete this many of the newest files, regardless of age. */
  keepRecentCount: number
}

export const DEFAULT_LOG_PRUNE_POLICY: LogPrunePolicy = {
  maxAgeMs: 14 * 24 * 60 * 60_000,
  maxTotalBytes: 200 * 1024 * 1024,
  keepRecentCount: 10,
}

/** Decide which files to delete. Newest-first survivors; protected paths
 *  (the live log files of running processes) are never returned. */
export function planLogPrune(
  files: PrunableFile[],
  now: number,
  policy: LogPrunePolicy = DEFAULT_LOG_PRUNE_POLICY,
  protectedPaths: ReadonlySet<string> = new Set(),
): string[] {
  const sorted = [...files].sort((a, b) => b.mtimeMs - a.mtimeMs)
  const doomed = new Set<string>()

  // Pass 1: age cap (skipping the always-keep head).
  sorted.forEach((f, i) => {
    if (i < policy.keepRecentCount) return
    if (now - f.mtimeMs > policy.maxAgeMs) doomed.add(f.path)
  })

  // Pass 2: total-size cap over the survivors, evicting oldest first.
  const survivors = sorted.filter((f) => !doomed.has(f.path))
  let total = survivors.reduce((s, f) => s + f.size, 0)
  for (let i = survivors.length - 1; i >= 0 && total > policy.maxTotalBytes; i--) {
    if (i < policy.keepRecentCount) break
    doomed.add(survivors[i].path)
    total -= survivors[i].size
  }

  for (const p of protectedPaths) doomed.delete(p)
  return [...doomed]
}

/** Sweep a logs directory. Best-effort: any fs error is swallowed — pruning
 *  must never take the daemon down. Returns how many files were deleted. */
export function pruneLogsDir(
  logsDir: string,
  protectedPaths: ReadonlySet<string> = new Set(),
  policy: LogPrunePolicy = DEFAULT_LOG_PRUNE_POLICY,
): number {
  let files: PrunableFile[] = []
  try {
    files = readdirSync(logsDir)
      .filter((n) => n.endsWith('.log'))
      .map((n) => {
        const path = join(logsDir, n)
        const st = statSync(path)
        return { path, mtimeMs: st.mtimeMs, size: st.size }
      })
  } catch {
    return 0
  }
  const doomed = planLogPrune(files, Date.now(), policy, protectedPaths)
  let deleted = 0
  for (const p of doomed) {
    try {
      unlinkSync(p)
      deleted++
    } catch {
      // file vanished or perms — skip
    }
  }
  return deleted
}
