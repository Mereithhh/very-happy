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
 */

import { randomUUID } from 'node:crypto'
import { logger } from '@/ui/logger'
import { readPersistedSessions, type PersistedSession } from '@/persistence'
import { sendUserMessage } from '@/commands/sessionMessage'
import { readSessionMetadata } from '@/sessions/sessionOps'
import { formatEditConflictNotice, SESSION_PEER_SENT_FROM, type PeerSender } from '@/sessions/peerMessage'
import { EditConflictTracker, EDIT_CONFLICT_WINDOW_MS, normalizeEditPath, type EditConflict } from './peerEdits'
import type { PeerSessionInfo, TrackedSession } from './types'

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
}

export interface PeerCoordinatorDeps {
    getChildren: () => TrackedSession[]
    /** Late-bound: the mirror manager is created after the control server. */
    getMirrors?: () => MirrorPeer[]
    windowMs?: number
    now?: () => number
    readPersisted?: () => Record<string, PersistedSession>
    send?: typeof sendUserMessage
    normalize?: (path: string, cwd: string) => string
    /** The daemon's metadata snapshot is from spawn time (no title yet); a
     *  notice fetches the live title from the server. Best-effort. */
    liveTitle?: (sessionId: string, persisted: PersistedSession) => Promise<string | undefined>
}

export interface PeerCoordinator {
    list(): PeerSessionInfo[]
    /** Record an edit; returns the notices it produced (already dispatched). */
    onEdit(edit: EditReport): EditConflict[]
    forget(sessionId: string): void
    setMirrorSource(getMirrors: () => MirrorPeer[]): void
}

function senderOf(info: PeerSessionInfo | undefined, sessionId: string): PeerSender {
    return { sessionId, title: info?.title, flavor: info?.flavor, cwd: info?.cwd }
}

export function createPeerCoordinator(deps: PeerCoordinatorDeps): PeerCoordinator {
    const now = deps.now ?? (() => Date.now())
    const windowMs = deps.windowMs ?? EDIT_CONFLICT_WINDOW_MS
    const tracker = new EditConflictTracker({ windowMs })
    const readPersisted = deps.readPersisted ?? readPersistedSessions
    const send = deps.send ?? sendUserMessage
    const normalize = deps.normalize ?? normalizeEditPath
    const liveTitle = deps.liveTitle ?? (async (sessionId, persisted) => (await readSessionMetadata(sessionId, persisted))?.summary?.text)
    let getMirrors = deps.getMirrors ?? (() => [])

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

    const deliver = async (recipient: PeerSessionInfo, peer: PeerSessionInfo | undefined, conflict: EditConflict, peerEdit: { sessionId: string; at: number }, noticeId: string) => {
        if (recipient.kind === 'mirror') return // no wrapper reads a shadow session's queue
        const persisted = readPersisted()[recipient.sessionId]
        if (!persisted) {
            logger.debug(`[PEERS] no key for ${recipient.sessionId}; conflict notice ${noticeId} not delivered`)
            return
        }
        const peerSender = senderOf(peer, peerEdit.sessionId)
        if (!peerSender.title && peer?.kind === 'managed') {
            const peerKey = readPersisted()[peer.sessionId]
            if (peerKey) {
                try { peerSender.title = await liveTitle(peer.sessionId, peerKey) } catch { /* spawn-time snapshot stays */ }
            }
        }
        const text = formatEditConflictNotice({
            id: noticeId,
            path: conflict.editor.path,
            peer: peerSender,
            peerEditedAgoMs: Math.max(0, conflict.editor.at - peerEdit.at),
            windowMs,
        })
        try {
            await send(recipient.sessionId, persisted, text, 'edit-conflict', {
                sentFrom: SESSION_PEER_SENT_FROM,
                delivery: 'steer',
                localId: `edit-conflict-${noticeId}-${recipient.sessionId}`,
            })
            logger.debug(`[PEERS] conflict notice ${noticeId} → ${recipient.sessionId} (file ${conflict.editor.path}, peer ${peerEdit.sessionId})`)
        } catch (error) {
            logger.debug(`[PEERS] conflict notice ${noticeId} → ${recipient.sessionId} failed:`, error)
        }
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
            const cwd = edit.cwd ?? self.cwd ?? process.cwd()
            const path = normalize(edit.path, cwd)
            const conflicts = tracker.record({ sessionId: edit.sessionId, path, tool: edit.tool, at: now() }, (id) => sessions.has(id))
            for (const conflict of conflicts) {
                const noticeId = randomUUID().slice(0, 8)
                const peer = sessions.get(conflict.peer.sessionId)
                // Both sides, each told about the other. The editor's own edit is
                // "now" from the peer's point of view.
                void deliver(self, peer, conflict, conflict.peer, noticeId)
                if (peer) void deliver(peer, self, conflict, { sessionId: edit.sessionId, at: conflict.editor.at }, noticeId)
            }
            return conflicts
        },

        forget: (sessionId) => tracker.forget(sessionId),

        setMirrorSource(source) { getMirrors = source },
    }
}
