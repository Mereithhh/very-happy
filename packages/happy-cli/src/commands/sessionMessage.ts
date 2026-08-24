/**
 * Shared primitives for pushing a user message into a happy session from the
 * CLI — used by `very-happy spawn` (first message of a fresh session) and
 * `very-happy send` (message into an EXISTING session).
 *
 * The mechanism mirrors the web's `sync.sendMessage` exactly (see web-v2
 * commit 388019d4): encrypt the user envelope
 * `{ role: 'user', content: { type: 'text', text } }` with the SESSION key
 * and POST it to `/v3/sessions/:id/messages` — the same REST outbox the web
 * client flushes through. The running session picks it up via its socket.
 *
 * Session keys come from `~/.happy/sessions.json`, which the daemon persists
 * from the session's `/session-started` webhook. Only sessions spawned by
 * THIS machine's daemon (recent enough to persist keys) are present there.
 */

import { randomUUID } from 'node:crypto'
import axios from 'axios'
import { configuration } from '@/configuration'
import { readCredentialsForConfiguredRelay, readPersistedSessions, type PersistedSession } from '@/persistence'
import { decodeBase64, encodeBase64, encrypt } from '@/api/encryption'
import { delay } from '@/utils/time'

/** Clickable web URL for a session id. */
export function sessionWebUrl(sessionId: string): string {
    return `${configuration.webappUrl.replace(/\/+$/, '')}/session/${sessionId}`
}

/**
 * Wait for the daemon to persist a session's encryption key into
 * `~/.happy/sessions.json`. Normally it is already there when /spawn-session
 * returns (the webhook precedes the spawn response), but we tolerate slow
 * disks / racy daemons with a bounded poll. `timeoutMs: 0` means a single
 * immediate check (for sessions that must already exist).
 */
export async function waitForSessionKey(sessionId: string, timeoutMs: number): Promise<PersistedSession> {
    const deadline = Date.now() + timeoutMs
    while (true) {
        const entry = readPersistedSessions()[sessionId]
        if (entry) return entry
        if (Date.now() >= deadline) {
            throw new Error(
                `Session ${sessionId} has no encryption key in ${configuration.sessionsFile}. ` +
                `Either it was not spawned by this machine's daemon, or the daemon is too old to persist session keys.`
            )
        }
        await delay(200)
    }
}

/**
 * Encrypt and POST one user message into a session whose key we already
 * hold. `client` tags the request's X-Happy-Client header (e.g. 'cli-spawn',
 * 'cli-send'). Throws on any failure.
 */
export async function sendUserMessage(
    sessionId: string,
    persisted: PersistedSession,
    text: string,
    client: string,
): Promise<void> {
    const credentials = await readCredentialsForConfiguredRelay()
    if (!credentials) {
        throw new Error('Not authenticated. Run `very-happy auth login` first.')
    }

    const envelope = {
        role: 'user' as const,
        content: {
            type: 'text' as const,
            text
        },
        meta: {
            sentFrom: 'cli'
        }
    }

    const encrypted = encodeBase64(encrypt(
        decodeBase64(persisted.encryptionKey),
        persisted.encryptionVariant,
        envelope
    ))

    await axios.post(
        `${configuration.serverUrl}/v3/sessions/${encodeURIComponent(sessionId)}/messages`,
        { messages: [{ content: encrypted, localId: randomUUID() }] },
        {
            headers: {
                'Authorization': `Bearer ${credentials.token}`,
                'Content-Type': 'application/json',
                'X-Happy-Client': `${client}/${configuration.currentCliVersion}`
            },
            timeout: 30_000
        }
    )
}
