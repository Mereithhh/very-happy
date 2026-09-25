/**
 * Daemon-side peer coordinator (B-497): the `/peers` listing and the
 * edit → conflict → notice pipeline, over `EditConflictTracker`.
 *
 * Everything the daemon knows about a session lives in two places — the
 * child table (managed wrappers, with the spawn-time metadata snapshot) and
 * the mirror manager (terminal Claude shadows). This module reads both,
 * normalises edit paths, and delivers the notices with the same REST outbox
 * the assistant report and Teams use (`sendUserMessage`). Delivery is
 * best-effort: a failure is logged, never retried, never surfaced to the
 * wrapper that reported the edit.
 *
 * Three guards keep the notices honest (review 2026-09-25):
 *  - an edit carries the time the runner saw it (`at`); the daemon clamps it
 *    to now and IGNORES anything older than the window — replayed transcript
 *    history (mirror backfill, file re-read, restart reconcile) is not "now";
 *  - conflicts for one pair of sessions are coalesced for `coalesceMs` and go
 *    out as ONE notice listing every file, instead of one notice per path;
 *  - each pair gets at most `maxNoticesPerPair` notices per window.
 */

import { randomUUID } from 'node:crypto'
import { logger } from '@/ui/logger'
import { readPersistedSessions, type PersistedSession } from '@/persistence'
import { sendUserMessage } from '@/commands/sessionMessage'
import { readSessionMetadata } from '@/sessions/sessionOps'
import { formatEditConflictNotice, SESSION_PEER_SENT_FROM, type PeerSender } from '@/sessions/peerMessage'
import { EditConflictTracker, EDIT_CONFLICT_WINDOW_MS, normalizeEditPath, type EditConflict } from './peerEdits'
import type { PeerSessionInfo, TrackedSession } from './types'

export const CONFLICT_COALESCE_MS = 10_000
export const MAX_NOTICES_PER_PAIR = 5

export interface MirrorPeer {
    sessionId: string
    cwd?: string
    title?: string
}

export interface EditReport {
    sessionId: string
    path: string
    tool: string
    cwd?: string
    /** When the runner saw the call; clamped to now, dropped when older than the window. */
    at?: number
}

export interface PeerCoordinatorDeps {
    getChildren: () => TrackedSession[]
    /** Late-bound: the mirror manager is created after the control server. */
    getMirrors?: () => MirrorPeer[]
    windowMs?: number
    coalesceMs?: number
    maxNoticesPerPair?: number
    now?: () => number
    readPersisted?: () => Record<string, PersistedSession>
    send?: typeof sendUserMessage
    normalize?: (path: string, cwd: string) => string
    /** The daemon's metadata snapshot is from spawn time (no title yet); a
     *  notice fetches the live title from the server. Best-effort. */
    liveTitle?: (sessionId: string, persisted: PersistedSession) => Promise<string | undefined>
    /** Injectable timer for tests. */
    schedule?: (fn: () => void, ms: number) => unknown
}

export interface PeerCoordinator {
    list(): PeerSessionInfo[]
    /** Record an edit; returns the conflicts it produced (notices are coalesced and sent later). */
    onEdit(edit: EditReport): EditConflict[]
    /** Deliver every pending coalesced notice now (tests / shutdown). */
    flush(): Promise<void>
    forget(sessionId: string): void
    setMirrorSource(getMirrors: () => MirrorPeer[]): void
}

interface PendingPair {
    a: string
    b: string
    /** path → { editor of the latest edit on that path, the peer's edit } */
    paths: Map<string, EditConflict>
    timer: unknown
}

function pairKey(a: string, b: string): string {
    return a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`
}

function senderOf(info: PeerSessionInfo | undefined, sessionId: string): PeerSender {
    return { sessionId, title: info?.title, flavor: info?.flavor, cwd: info?.cwd }
}

export function createPeerCoordinator(deps: PeerCoordinatorDeps): PeerCoordinator {
    const now = deps.now ?? (() => Date.now())
    const windowMs = deps.windowMs ?? EDIT_CONFLICT_WINDOW_MS
    const coalesceMs = deps.coalesceMs ?? CONFLICT_COALESCE_MS
    const maxNoticesPerPair = deps.maxNoticesPerPair ?? MAX_NOTICES_PER_PAIR
    const tracker = new EditConflictTracker({ windowMs })
    const readPersisted = deps.readPersisted ?? readPersistedSessions
    const send = deps.send ?? sendUserMessage
    const normalize = deps.normalize ?? normalizeEditPath
    const liveTitle = deps.liveTitle ?? (async (sessionId, persisted) => (await readSessionMetadata(sessionId, persisted))?.summary?.text)
    const schedule = deps.schedule ?? ((fn, ms) => { const t = setTimeout(fn, ms); (t as { unref?: () => void }).unref?.(); return t })
    let getMirrors = deps.getMirrors ?? (() => [])
    const pending = new Map<string, PendingPair>()
    /** pair → times a notice went out (window-pruned). */
    const noticesSent = new Map<string, number[]>()
    let inflight: Promise<void> = Promise.resolve()

    const snapshot = (): Map<string, PeerSessionInfo> => {
        const at = now()
        const out = new Map<string, PeerSessionInfo>()
        for (const child of deps.getChildren()) {
            const id = child.happySessionId
            if (!id || out.has(id)) continue
            const meta = child.happySessionMetadataFromLocalWebhook as (TrackedSession['happySessionMetadataFromLocalWebhook'] & { variant?: string }) | undefined
            out.set(id, {
                sessionId: id,
                kind: 'managed',
                pid: child.pid,
                ...(meta?.path ? { cwd: meta.path } : {}),
                ...(meta?.flavor ? { flavor: meta.flavor } : {}),
                ...(meta?.summary?.text ? { title: meta.summary.text } : {}),
                ...(meta?.variant ?? child.variant ? { variant: meta?.variant ?? child.variant } : {}),
                edits: tracker.editsOf(id, at),
            })
        }
        for (const mirror of getMirrors()) {
            if (out.has(mirror.sessionId)) continue
            out.set(mirror.sessionId, {
                sessionId: mirror.sessionId,
                kind: 'mirror',
                flavor: 'terminal-mirror',
                ...(mirror.cwd ? { cwd: mirror.cwd } : {}),
                ...(mirror.title ? { title: mirror.title } : {}),
                edits: tracker.editsOf(mirror.sessionId, at),
            })
        }
        return out
    }

    const deliver = async (recipient: PeerSessionInfo, peer: PeerSessionInfo | undefined, peerId: string, paths: string[], peerEditedAgoMs: number, noticeId: string) => {
        if (recipient.kind === 'mirror') return // no wrapper reads a shadow session's queue
        const persisted = readPersisted()[recipient.sessionId]
        if (!persisted) {
            logger.debug(`[PEERS] no key for ${recipient.sessionId}; conflict notice ${noticeId} not delivered`)
            return
        }
        const peerSender = senderOf(peer, peerId)
        if (!peerSender.title && peer?.kind === 'managed') {
            const peerKey = readPersisted()[peer.sessionId]
            if (peerKey) {
                try { peerSender.title = await liveTitle(peer.sessionId, peerKey) } catch { /* spawn-time snapshot stays */ }
            }
        }
        const text = formatEditConflictNotice({ id: noticeId, path: paths[0], paths, peer: peerSender, peerEditedAgoMs, windowMs })
        try {
            await send(recipient.sessionId, persisted, text, 'edit-conflict', {
                sentFrom: SESSION_PEER_SENT_FROM,
                delivery: 'steer',
                localId: `edit-conflict-${noticeId}-${recipient.sessionId}`,
            })
            logger.debug(`[PEERS] conflict notice ${noticeId} → ${recipient.sessionId} (${paths.length} file(s), first ${paths[0]}, peer ${peerId})`)
        } catch (error) {
            logger.debug(`[PEERS] conflict notice ${noticeId} → ${recipient.sessionId} failed:`, error)
        }
    }

    const flushPair = async (key: string) => {
        const pair = pending.get(key)
        if (!pair) return
        pending.delete(key)
        const at = now()
        const sent = (noticesSent.get(key) ?? []).filter((t) => at - t <= windowMs)
        if (sent.length >= maxNoticesPerPair) {
            noticesSent.set(key, sent)
            logger.debug(`[PEERS] pair ${pair.a}/${pair.b}: ${maxNoticesPerPair} notices already sent this window; ${pair.paths.size} conflicting path(s) not announced`)
            return
        }
        sent.push(at)
        noticesSent.set(key, sent)
        const sessions = snapshot()
        const a = sessions.get(pair.a)
        const b = sessions.get(pair.b)
        const paths = [...pair.paths.keys()]
        const noticeId = randomUUID().slice(0, 8)
        // From each side's point of view: how long ago did the OTHER side last edit any of these files.
        const latestBy = (sessionId: string) => Math.max(...[...pair.paths.values()].map((c) => (c.editor.sessionId === sessionId ? c.editor.at : c.peer.at)))
        const agoFor = (recipientId: string, otherId: string) => Math.max(0, latestBy(recipientId) - latestBy(otherId))
        if (a) await deliver(a, b, pair.b, paths, agoFor(pair.a, pair.b), noticeId)
        if (b) await deliver(b, a, pair.a, paths, agoFor(pair.b, pair.a), noticeId)
    }

    const enqueue = (conflict: EditConflict) => {
        const key = pairKey(conflict.editor.sessionId, conflict.peer.sessionId)
        let pair = pending.get(key)
        if (!pair) {
            pair = { a: conflict.editor.sessionId, b: conflict.peer.sessionId, paths: new Map(), timer: null }
            pair.timer = schedule(() => { inflight = inflight.then(() => flushPair(key)).catch(() => {}) }, coalesceMs)
            pending.set(key, pair)
        }
        pair.paths.set(conflict.editor.path, conflict)
    }

    return {
        list: () => [...snapshot().values()],

        onEdit(edit) {
            const sessions = snapshot()
            const self = sessions.get(edit.sessionId)
            if (!self) {
                logger.debug(`[PEERS] edit from unknown/dead session ${edit.sessionId} ignored`)
                return []
            }
            const current = now()
            const at = typeof edit.at === 'number' && Number.isFinite(edit.at) ? Math.min(edit.at, current) : current
            if (current - at > windowMs) {
                logger.debug(`[PEERS] edit from ${edit.sessionId} on ${edit.path} is ${Math.round((current - at) / 60_000)}m old (replayed history); ignored`)
                return []
            }
            const cwd = edit.cwd ?? self.cwd ?? process.cwd()
            const path = normalize(edit.path, cwd)
            const conflicts = tracker.record({ sessionId: edit.sessionId, path, tool: edit.tool, at }, (id) => sessions.has(id))
            for (const conflict of conflicts) enqueue(conflict)
            return conflicts
        },

        async flush() {
            for (const key of [...pending.keys()]) {
                const pair = pending.get(key)
                if (pair?.timer && typeof pair.timer === 'object') clearTimeout(pair.timer as NodeJS.Timeout)
                inflight = inflight.then(() => flushPair(key)).catch(() => {})
            }
            await inflight
        },

        forget(sessionId) {
            tracker.forget(sessionId)
            for (const [key, pair] of pending) {
                if (pair.a === sessionId || pair.b === sessionId) {
                    if (pair.timer && typeof pair.timer === 'object') clearTimeout(pair.timer as NodeJS.Timeout)
                    pending.delete(key)
                }
            }
        },

        setMirrorSource(source) { getMirrors = source },
    }
}
