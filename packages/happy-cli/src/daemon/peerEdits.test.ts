import { describe, expect, it } from 'vitest'
import { EditConflictTracker, normalizeEditPath } from './peerEdits'

const live = () => true
const edit = (sessionId: string, at: number, path = '/r/a.ts', tool = 'Edit') => ({ sessionId, path, tool, at })

describe('EditConflictTracker (B-497)', () => {
    it('reports a conflict when a second live session edits the same path inside the window', () => {
        const tracker = new EditConflictTracker({ windowMs: 60_000 })
        expect(tracker.record(edit('a', 1_000), live)).toEqual([])
        expect(tracker.record(edit('b', 10_000), live)).toEqual([{ editor: edit('b', 10_000), peer: edit('a', 1_000) }])
    })

    it('notifies one pair per path once per window, then again after it lapses', () => {
        const tracker = new EditConflictTracker({ windowMs: 60_000 })
        tracker.record(edit('a', 1_000), live)
        expect(tracker.record(edit('b', 2_000), live)).toHaveLength(1)
        expect(tracker.record(edit('a', 3_000), live)).toEqual([])
        expect(tracker.record(edit('b', 4_000), live)).toEqual([])
        // Another path is another notice.
        tracker.record(edit('a', 5_000, '/r/b.ts'), live)
        expect(tracker.record(edit('b', 6_000, '/r/b.ts'), live)).toHaveLength(1)
        // Window lapsed since the last notice on a.ts (a kept editing, so the path is still warm).
        tracker.record(edit('a', 61_000), live)
        expect(tracker.record(edit('b', 63_000), live)).toHaveLength(1)
    })

    it('ignores stale edits and sessions that are no longer live', () => {
        const tracker = new EditConflictTracker({ windowMs: 60_000 })
        tracker.record(edit('a', 1_000), live)
        expect(tracker.record(edit('b', 70_000), live)).toEqual([])
        tracker.record(edit('c', 71_000), live)
        expect(tracker.record(edit('d', 72_000), (id) => id !== 'c')).toEqual([{ editor: edit('d', 72_000), peer: edit('b', 70_000) }])
        expect(tracker.editsOf('c', 72_000)).toEqual([])
    })

    it('forgets a session and lists a session’s recent edits newest first', () => {
        const tracker = new EditConflictTracker({ windowMs: 60_000 })
        tracker.record(edit('a', 1_000, '/r/one.ts'), live)
        tracker.record(edit('a', 5_000, '/r/two.ts', 'Write'), live)
        tracker.record(edit('b', 6_000, '/r/two.ts'), live)
        expect(tracker.editsOf('a', 10_000)).toEqual([{ path: '/r/two.ts', tool: 'Write', at: 5_000 }, { path: '/r/one.ts', tool: 'Edit', at: 1_000 }])
        tracker.forget('a')
        expect(tracker.editsOf('a', 10_000)).toEqual([])
        expect(tracker.size()).toBe(1)
        // The pair dedupe was cleared with the session: a returning `a` is told again.
        expect(tracker.record(edit('a', 11_000, '/r/two.ts'), live)).toHaveLength(1)
    })

    it('prunes by window and caps the table', () => {
        const tracker = new EditConflictTracker({ windowMs: 1_000, maxPaths: 2 })
        tracker.record(edit('a', 1, '/1'), live)
        tracker.record(edit('a', 2, '/2'), live)
        tracker.record(edit('a', 3, '/3'), live)
        tracker.prune(3)
        expect(tracker.size()).toBe(2)
        tracker.prune(5_000)
        expect(tracker.size()).toBe(0)
    })
})

describe('normalizeEditPath', () => {
    const realpath = (p: string) => {
        if (p === '/link/repo') return '/real/repo'
        if (p === '/link/repo/src') return '/real/repo/src'
        if (p.startsWith('/link/repo/src/') && !p.includes('missing')) return p.replace('/link/repo', '/real/repo')
        const err = new Error('ENOENT') as NodeJS.ErrnoException; err.code = 'ENOENT'; throw err
    }

    it('resolves relative paths against the cwd and realpaths the existing prefix', () => {
        expect(normalizeEditPath('src/a.ts', '/link/repo', realpath)).toBe('/real/repo/src/a.ts')
        expect(normalizeEditPath('/link/repo/src/a.ts', '/elsewhere', realpath)).toBe('/real/repo/src/a.ts')
    })

    it('keeps the not-yet-existing tail under the realpath of its longest existing ancestor', () => {
        expect(normalizeEditPath('src/missing/deep/new.ts', '/link/repo', realpath)).toBe('/real/repo/src/missing/deep/new.ts')
    })

    it('falls back to the absolute path when nothing resolves', () => {
        expect(normalizeEditPath('/nowhere/x.ts', '/link/repo', realpath)).toBe('/nowhere/x.ts')
    })
})
