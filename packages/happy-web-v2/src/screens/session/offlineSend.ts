/**
 * B-799: what the send button does while the app judges the device offline.
 *
 * `queue`: a text send enters the outbox / server-queue row at once (B-513 /
 * B-722) and goes out by itself when the network is back — the deadline is
 * paused while offline, the outbox retries without limit and the recovery
 * edge flushes it (sync.flushOutboxesNow, retryWaitingPrompts).
 * `blocked`: attachments upload over HTTP before the message exists; offline
 * that upload fails and the turn bounces back into the composer, so the
 * button waits for the network instead (follow-up: B-734).
 */
export type OfflineSendState = 'queue' | 'blocked' | null;

export function offlineSendState(offline: boolean, hasAttachments: boolean): OfflineSendState {
    if (!offline) return null;
    return hasAttachments ? 'blocked' : 'queue';
}
