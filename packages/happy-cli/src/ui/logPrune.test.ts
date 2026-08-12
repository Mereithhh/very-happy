import { describe, it, expect } from 'vitest'
import { planLogPrune, type PrunableFile, type LogPrunePolicy } from './logPrune'

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
