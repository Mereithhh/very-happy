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
import { closeSync, ftruncateSync, openSync, readSync, readdirSync, statSync, unlinkSync, utimesSync, writeSync } from 'node:fs'
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
  /**
   * B-856: logs of previous daemon processes (`*-daemon.log`) kept outside the
   * general caps, newest first, so release forensics survive the handover. A
   * busy machine's live wrapper logs are always newer, so the general size cap
   * used to delete the previous daemon's log at the very next start.
   */
  keepDaemonLogs?: number
  /** B-856: total bytes for those daemon logs; the newest one is cut to its tail rather than dropped. */
  maxDaemonLogBytes?: number
}

export const DEFAULT_LOG_PRUNE_POLICY: LogPrunePolicy = {
  maxAgeMs: 14 * 24 * 60 * 60_000,
  maxTotalBytes: 200 * 1024 * 1024,
  keepRecentCount: 10,
  keepDaemonLogs: 3,
  maxDaemonLogBytes: 64 * 1024 * 1024,
}

export const DAEMON_LOG_SUFFIX = '-daemon.log'

export interface DaemonLogRetention {
  /** Previous daemon logs exempt from the general age / size passes. */
  keep: Set<string>
  /** The newest previous daemon log is larger than the budget: keep only its last `keepBytes`. */
  trim: { path: string; keepBytes: number } | null
}

/**
 * B-856: which previous daemon logs to keep. The newest is always kept (cut
 * to the budget when larger); older ones only while they fit the remaining
 * budget and the count. Protected paths (the live daemon's own log) are not
 * "previous" and are left out.
 */
export function planDaemonLogRetention(
  files: PrunableFile[],
  policy: LogPrunePolicy = DEFAULT_LOG_PRUNE_POLICY,
  protectedPaths: ReadonlySet<string> = new Set(),
): DaemonLogRetention {
  const keep = new Set<string>()
  let trim: DaemonLogRetention['trim'] = null
  const count = policy.keepDaemonLogs ?? 0
  let budget = policy.maxDaemonLogBytes ?? 0
  if (count <= 0 || budget <= 0) return { keep, trim }
  const daemonLogs = files
    .filter((f) => f.path.endsWith(DAEMON_LOG_SUFFIX) && !protectedPaths.has(f.path))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
  for (const f of daemonLogs) {
    if (keep.size >= count || budget <= 0) break
    if (keep.size === 0) {
      keep.add(f.path)
      if (f.size > budget) { trim = { path: f.path, keepBytes: budget }; budget = 0 }
      else budget -= f.size
      continue
    }
    if (f.size > budget) break
    keep.add(f.path)
    budget -= f.size
  }
  return { keep, trim }
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
  // B-856: previous daemon logs have their own count and byte budget.
  const daemonLogs = planDaemonLogRetention(files, policy, protectedPaths)
  if (daemonLogs.trim) trimToTail(daemonLogs.trim.path, daemonLogs.trim.keepBytes)
  const doomed = planLogPrune(files.filter((f) => !daemonLogs.keep.has(f.path)), Date.now(), policy, protectedPaths)
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

/**
 * Keep only the last `keepBytes` of a file, in place, under a one-line marker;
 * the modification time is kept so the file keeps its place in the order.
 * Best-effort like the rest.
 */
export function trimToTail(path: string, keepBytes: number): void {
  let fd: number | null = null
  try {
    const st = statSync(path)
    if (st.size <= keepBytes) return
    const marker = Buffer.from(`[log trimmed to its last ${keepBytes} bytes by the daemon log retention]\n`)
    const tailBytes = Math.max(0, keepBytes - marker.length)
    fd = openSync(path, 'r+')
    const tail = Buffer.alloc(tailBytes)
    let read = 0
    while (read < tailBytes) {
      const n = readSync(fd, tail, read, tailBytes - read, st.size - tailBytes + read)
      if (n <= 0) break
      read += n
    }
    writeSync(fd, marker, 0, marker.length, 0)
    writeSync(fd, tail, 0, read, marker.length)
    ftruncateSync(fd, marker.length + read)
    closeSync(fd)
    fd = null
    utimesSync(path, st.atime, st.mtime)
  } catch {
    // vanished or perms — skip
  } finally {
    if (fd !== null) try { closeSync(fd) } catch { /* ignore */ }
  }
}
