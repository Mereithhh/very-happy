import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { planDaemonLogRetention, planLogPrune, pruneLogsDir, trimToTail, type PrunableFile, type LogPrunePolicy } from './logPrune'

const DAY = 24 * 60 * 60_000
const NOW = 1_800_000_000_000

const policy: LogPrunePolicy = {
  maxAgeMs: 14 * DAY,
  maxTotalBytes: 1000,
  keepRecentCount: 2,
}

function f(path: string, ageDays: number, size: number): PrunableFile {
  return { path, mtimeMs: NOW - ageDays * DAY, size }
}

describe('planLogPrune', () => {
  it('deletes files past the age cap', () => {
    const files = [f('/l/new.log', 1, 10), f('/l/mid.log', 5, 10), f('/l/old.log', 30, 10)]
    expect(planLogPrune(files, NOW, policy)).toEqual(['/l/old.log'])
  })

  it('keepRecentCount shields the newest files even when ancient', () => {
    const files = [f('/l/a.log', 100, 10), f('/l/b.log', 200, 10)]
    expect(planLogPrune(files, NOW, policy)).toEqual([])
  })

  it('size cap evicts oldest-first until under budget', () => {
    const files = [f('/l/a.log', 1, 600), f('/l/b.log', 2, 600), f('/l/c.log', 3, 600)]
    // total 1800 > 1000: evict c (oldest); then 1200 > 1000 but b is inside
    // keepRecentCount=2 head — stop.
    expect(planLogPrune(files, NOW, policy)).toEqual(['/l/c.log'])
  })

  it('age and size passes combine', () => {
    const files = [
      f('/l/a.log', 1, 900),
      f('/l/b.log', 2, 900),
      f('/l/stale.log', 30, 5),
      f('/l/big-old.log', 10, 900),
    ]
    const out = planLogPrune(files, NOW, policy)
    expect(out).toContain('/l/stale.log') // age
    expect(out).toContain('/l/big-old.log') // size, outside keep-head
    expect(out).not.toContain('/l/a.log')
    expect(out).not.toContain('/l/b.log')
  })

  it('never deletes protected paths', () => {
    const files = [f('/l/live.log', 30, 2000), f('/l/a.log', 1, 10), f('/l/b.log', 2, 10)]
    const out = planLogPrune(files, NOW, policy, new Set(['/l/live.log']))
    expect(out).not.toContain('/l/live.log')
  })

  it('empty input → empty plan', () => {
    expect(planLogPrune([], NOW, policy)).toEqual([])
  })
})

describe('B-856 previous daemon logs survive the next daemon start', () => {
  const dpolicy: LogPrunePolicy = { maxAgeMs: 14 * DAY, maxTotalBytes: 1000, keepRecentCount: 2, keepDaemonLogs: 2, maxDaemonLogBytes: 500 }

  it('keeps the newest previous daemon logs within count and budget; never the live one', () => {
    const files = [
      f('/l/live-daemon.log', 0, 50),
      f('/l/prev-daemon.log', 1, 200),
      f('/l/prev2-daemon.log', 2, 200),
      f('/l/prev3-daemon.log', 3, 10),
      f('/l/wrapper.log', 0, 10),
    ]
    const plan = planDaemonLogRetention(files, dpolicy, new Set(['/l/live-daemon.log']))
    expect([...plan.keep]).toEqual(['/l/prev-daemon.log', '/l/prev2-daemon.log'])
    expect(plan.trim).toBeNull()
  })

  it('an older one that does not fit the remaining budget is not kept (the count may not be reached)', () => {
    const plan = planDaemonLogRetention([f('/l/a-daemon.log', 1, 400), f('/l/b-daemon.log', 2, 200)], dpolicy)
    expect([...plan.keep]).toEqual(['/l/a-daemon.log'])
  })

  it('the newest previous log is kept even when larger than the budget, cut to its tail', () => {
    const plan = planDaemonLogRetention([f('/l/huge-daemon.log', 1, 5000), f('/l/b-daemon.log', 2, 10)], dpolicy)
    expect([...plan.keep]).toEqual(['/l/huge-daemon.log'])
    expect(plan.trim).toEqual({ path: '/l/huge-daemon.log', keepBytes: 500 })
  })

  it('disabled policy keeps nothing extra', () => {
    expect(planDaemonLogRetention([f('/l/a-daemon.log', 1, 10)], policy).keep.size).toBe(0)
  })

  it('field case: busy wrapper logs are newer and larger, yet the previous daemon log survives the sweep', () => {
    const dir = mkdtempSync(join(tmpdir(), 'b856-logs-'))
    try {
      const now = Date.now() / 1000
      const put = (name: string, bytes: number, ageSec: number) => {
        writeFileSync(join(dir, name), 'x'.repeat(bytes))
        utimesSync(join(dir, name), now - ageSec, now - ageSec)
      }
      put('old-daemon.log', 100, 3600)
      put('prev-daemon.log', 300, 600)
      for (let i = 0; i < 5; i++) put(`wrapper-${i}.log`, 400, 60 - i)
      put('live-daemon.log', 10, 0)
      const deleted = pruneLogsDir(dir, new Set([join(dir, 'live-daemon.log')]), { ...dpolicy, keepDaemonLogs: 1 })
      const left = readdirSync(dir).sort()
      expect(left).toContain('prev-daemon.log')
      expect(left).toContain('live-daemon.log')
      expect(left).not.toContain('old-daemon.log')
      expect(deleted).toBeGreaterThan(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('trimToTail keeps the last bytes under a marker and keeps the mtime', () => {
    const dir = mkdtempSync(join(tmpdir(), 'b856-trim-'))
    try {
      const path = join(dir, 'big-daemon.log')
      writeFileSync(path, 'HEAD-' + 'm'.repeat(1000) + '-TAIL')
      utimesSync(path, 1_700_000_000, 1_700_000_000)
      trimToTail(path, 200)
      const text = readFileSync(path, 'utf8')
      expect(text.length).toBeLessThanOrEqual(200)
      expect(text.startsWith('[log trimmed')).toBe(true)
      expect(text.endsWith('-TAIL')).toBe(true)
      expect(text).not.toContain('HEAD-')
      expect(Math.round(statSync(path).mtimeMs / 1000)).toBe(1_700_000_000)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
