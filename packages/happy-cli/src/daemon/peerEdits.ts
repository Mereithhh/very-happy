/**
 * Edit-conflict tracker (B-497) — the daemon's short-term "real path →
 * sessions that edited it" table, and the notice dedupe.
 *
 * Pure: time is injected, liveness is a callback. The daemon feeds it from
 * `/session-edit` (managed wrappers) and from the mirror manager (terminal
 * Claude), and delivers the notices `record()` returns. No lock, no veto:
 * the table only decides WHO is told WHAT, once per (pair, path, window).
 */

import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { realpathSync } from 'node:fs'

export const EDIT_CONFLICT_WINDOW_MS = 30 * 60_000

export interface RecordedEdit {
    sessionId: string
    path: string
    tool: string
    at: number
}

export interface EditConflict {
    /** The session whose edit triggered the notice. */
    editor: RecordedEdit
    /** Another live session that edited the same real path inside the window. */
    peer: RecordedEdit
}

export interface EditConflictTrackerOptions {
    windowMs?: number
    /** Upper bound on distinct paths kept; oldest are evicted first. */
    maxPaths?: number
}

function pairKey(a: string, b: string, path: string): string {
    return a < b ? `${a}\u0000${b}\u0000${path}` : `${b}\u0000${a}\u0000${path}`
}

export class EditConflictTracker {
    private readonly windowMs: number
    private readonly maxPaths: number
    /** real path → sessionId → latest edit */
    private readonly byPath = new Map<string, Map<string, RecordedEdit>>()
    /** (sorted pair, path) → when the notice went out */
    private readonly notified = new Map<string, number>()

    constructor(options: EditConflictTrackerOptions = {}) {
        this.windowMs = options.windowMs ?? EDIT_CONFLICT_WINDOW_MS
        this.maxPaths = options.maxPaths ?? 5_000
    }

    /**
     * Remember an edit and return the peers to notify about it. `isLive`
     * decides whether another session still counts (dead ones are dropped
     * from the table on the spot).
     */
    record(edit: RecordedEdit, isLive: (sessionId: string) => boolean): EditConflict[] {
        this.prune(edit.at)
        let sessions = this.byPath.get(edit.path)
        if (!sessions) {
            sessions = new Map()
            this.byPath.set(edit.path, sessions)
        }
        const conflicts: EditConflict[] = []
        for (const [sessionId, peer] of sessions) {
            if (sessionId === edit.sessionId) continue
            if (!isLive(sessionId)) { sessions.delete(sessionId); continue }
            if (edit.at - peer.at > this.windowMs) continue
            const key = pairKey(edit.sessionId, sessionId, edit.path)
            const notifiedAt = this.notified.get(key)
            if (notifiedAt !== undefined && edit.at - notifiedAt <= this.windowMs) continue
            this.notified.set(key, edit.at)
            conflicts.push({ editor: edit, peer })
        }
        sessions.set(edit.sessionId, edit)
        return conflicts
    }

    /** Paths this session edited inside the window, newest first. */
    editsOf(sessionId: string, now: number, limit = 20): Array<{ path: string; tool: string; at: number }> {
        const out: Array<{ path: string; tool: string; at: number }> = []
        for (const [path, sessions] of this.byPath) {
            const edit = sessions.get(sessionId)
            if (edit && now - edit.at <= this.windowMs) out.push({ path, tool: edit.tool, at: edit.at })
        }
        return out.sort((a, b) => b.at - a.at).slice(0, limit)
    }

    /** Session ended: nothing it did counts any more. */
    forget(sessionId: string): void {
        for (const [path, sessions] of this.byPath) {
            sessions.delete(sessionId)
            if (sessions.size === 0) this.byPath.delete(path)
        }
        for (const key of this.notified.keys()) {
            const [a, b] = key.split('\u0000')
            if (a === sessionId || b === sessionId) this.notified.delete(key)
        }
    }

    /** Drop everything older than the window (and cap the table size). */
    prune(now: number): void {
        for (const [path, sessions] of this.byPath) {
            for (const [sessionId, edit] of sessions) if (now - edit.at > this.windowMs) sessions.delete(sessionId)
            if (sessions.size === 0) this.byPath.delete(path)
        }
        for (const [key, at] of this.notified) if (now - at > this.windowMs) this.notified.delete(key)
        if (this.byPath.size > this.maxPaths) {
            const oldest = [...this.byPath.entries()]
                .map(([path, sessions]) => ({ path, at: Math.max(...[...sessions.values()].map((e) => e.at)) }))
                .sort((a, b) => a.at - b.at)
            for (const entry of oldest.slice(0, this.byPath.size - this.maxPaths)) this.byPath.delete(entry.path)
        }
    }

    /** Test / diagnostics helper. */
    size(): number {
        return this.byPath.size
    }
}

/**
 * One key per real file: relative paths resolve against the session cwd, then
 * the longest EXISTING ancestor is realpath'd (a `Write` targets a file that
 * does not exist yet; symlinked checkouts must still collide). Never throws.
 */
export function normalizeEditPath(path: string, cwd: string, realpath: (p: string) => string = realpathSync.native ?? realpathSync): string {
    const absolute = isAbsolute(path) ? resolve(path) : resolve(cwd, path)
    let existing = absolute
    const tail: string[] = []
    for (let depth = 0; depth < 64; depth++) {
        try {
            const real = realpath(existing)
            return tail.length ? join(real, ...tail) : real
        } catch {
            const parent = dirname(existing)
            if (parent === existing) break
            tail.unshift(existing.slice(parent.length).replace(new RegExp(`^\\${sep}`), ''))
            existing = parent
        }
    }
    return absolute
}
