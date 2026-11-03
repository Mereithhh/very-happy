/**
 * B-880 — an imported (or forked) conversation whose history is still
 * uploading.
 *
 * The wrapper replays the whole transcript into the new session's message log
 * (CLI utils/forkBackfill.ts). ImportHistoryModal opens the session as soon as
 * the import RPC answers, i.e. while that upload runs. Before this, the open
 * session took the upload like live traffic: one push per replayed message,
 * each merged, reduced and rendered, the transcript growing from its OLDEST
 * message. A 31,674-message import (28.9 MB transcript) showed its newest
 * message 312 s after the open, froze the page for up to 225 s and peaked at
 * 1.17 GB of JS heap; a 2,004-line one under the production rate limit took 417 s.
 *
 * Now such a session is parked while it uploads: no catch-up, pushes for it
 * dropped, the chat area shows the progress (`ImportProgress`). Once the
 * wrapper writes the final marker, it opens like any other session — the
 * newest page first, older pages on demand (sync/historyWindow.ts).
 *
 * The wrapper writes `metadata.forkBackfill = { done: false, total, sent }`
 * while it uploads (CLIs with B-880; older wrappers write only the final
 * `done: true` marker, and their sessions behave as before). A wrapper that
 * dies mid-upload leaves `done: false` behind; an inactive session is
 * therefore never parked — it shows whatever reached the server.
 */
import type { Session } from './storageTypes';

export interface ImportUploadProgress {
    total: number;
    sent: number;
}

export function importUploadProgress(session: Pick<Session, 'active' | 'metadata'> | null | undefined): ImportUploadProgress | null {
    if (!session?.active) return null;
    const marker = session.metadata?.forkBackfill;
    if (!marker || marker.done !== false) return null;
    const total = typeof marker.total === 'number' && marker.total > 0 ? marker.total : 0;
    const sent = typeof marker.sent === 'number' && marker.sent > 0 ? Math.min(marker.sent, total) : 0;
    return { total, sent };
}
