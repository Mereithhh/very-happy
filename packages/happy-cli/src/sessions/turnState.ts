/**
 * Where the latest turn of a session stands, from its decrypted message log
 * (B-492 — `very-happy sessions read --wait / --answer`). Pure; unit-tested.
 *
 * The log interleaves user prompts with the agent's session-protocol envelopes
 * (claude and codex both emit `{ role: 'session', content: { ev: … } }`, with
 * `turn-start` / `turn-end` markers). "The latest turn" is everything after
 * the most recent user prompt:
 * - it has ended once a `turn-end` follows that prompt;
 * - if the window we fetched holds no user prompt (a very long turn), fall
 *   back to the last turn marker — ended iff it is a `turn-end`.
 * All three session-protocol producers (claude, codex, ACP) emit both markers.
 * A prompt sent while the previous turn is still running is followed by that
 * turn's `turn-end` BEFORE its own `turn-start`, so when the agent emits
 * starts at all, a `turn-end` only counts once a `turn-start` followed the prompt.
 */

export interface LogEntry {
    seq: number
    /** Decrypted body, or null when it could not be decrypted. */
    body: unknown | null
}

export interface TurnState {
    /** seq of the latest user prompt in the window (null: none in window). */
    userSeq: number | null
    ended: boolean
    /** turn-end status when ended ('completed' | 'failed' | 'cancelled'). */
    status: string | null
    error: string | null
    /**
     * The agent's reply to the latest prompt: the text it wrote after its last
     * tool call in this turn (the conclusion, not the running commentary).
     * Untruncated. Empty when it has written nothing yet.
     */
    answer: string
    /** Highest seq in the window (0 when empty) — resume point for polling. */
    lastSeq: number
}

type Envelope = { role?: string; ev?: Record<string, any> }

function asRecord(value: unknown): Record<string, any> | null {
    return value && typeof value === 'object' ? value as Record<string, any> : null
}

function sessionEnvelope(body: unknown): Envelope | null {
    const b = asRecord(body)
    if (!b || b.role !== 'session') return null
    const env = asRecord(b.content)
    if (!env) return null
    const ev = asRecord(env.ev)
    return ev && typeof ev.t === 'string' ? { role: env.role, ev } : null
}

/**
 * A prompt as the web / CLI send it (plain `role: 'user'` text through the
 * outbox). Session envelopes with `role: 'user'` are the agent's own echoes
 * (claude mapper after closing a turn, codex history replay placing the user
 * item AFTER its turn-start) — counting those would anchor on the wrong spot.
 */
function isUserPrompt(body: unknown): boolean {
    const b = asRecord(body)
    return !!b && b.role === 'user' && b.content?.type === 'text' && typeof b.content.text === 'string'
}

type Piece = { kind: 'text'; text: string } | { kind: 'tool' }

/** Agent output that counts toward the answer: visible text, or a tool call (which resets it). */
function agentPiece(body: unknown): Piece | null {
    const env = sessionEnvelope(body)
    if (env && env.role !== 'user') {
        if (env.ev!.t === 'text' && !env.ev!.thinking) {
            const text = String(env.ev!.text ?? '')
            return text.trim().length > 0 ? { kind: 'text', text } : null
        }
        if (env.ev!.t === 'tool-call-start') return { kind: 'tool' }
        return null
    }
    const b = asRecord(body)
    if (b?.role === 'agent' && b.content?.type === 'acp') {
        const d = asRecord(b.content.data)
        if (d?.type === 'message') {
            const text = String(d.message ?? '')
            return text.trim().length > 0 ? { kind: 'text', text } : null
        }
        if (d?.type === 'tool-call') return { kind: 'tool' }
    }
    return null
}

export interface AnalyzeTurnOptions {
    /**
     * B-496: anchor on the latest user prompt matching this predicate instead
     * of the latest prompt overall, and count only the turn markers after it —
     * a human typing into the same session later must not move the anchor.
     * Once that anchored turn has ended, a later prompt stops the scan.
     */
    anchor?: (body: unknown) => boolean
}

/** Text of a user prompt body (null when it is not one). */
export function userPromptText(body: unknown): string | null {
    return isUserPrompt(body) ? (body as { content: { text: string } }).content.text : null
}

/** Entries must be in ascending seq order. */
export function analyzeLatestTurn(entries: LogEntry[], options: AnalyzeTurnOptions = {}): TurnState {
    const lastSeq = entries.length > 0 ? entries[entries.length - 1].seq : 0
    let userIndex = -1
    for (let i = entries.length - 1; i >= 0; i--) {
        if (isUserPrompt(entries[i].body) && (!options.anchor || options.anchor(entries[i].body))) { userIndex = i; break }
    }

    let ended = false
    let status: string | null = null
    let error: string | null = null
    let texts: string[] = []
    let lastMarker: 'start' | 'end' | null = null
    let startedAfterPrompt = false
    const emitsStarts = entries.some((entry) => sessionEnvelope(entry.body)?.ev?.t === 'turn-start')

    for (let i = userIndex + 1; i < entries.length; i++) {
        const body = entries[i].body
        if (options.anchor && isUserPrompt(body)) {
            // Someone else's prompt after ours: our turn is closed if it ended;
            // otherwise it is still queued behind ours and its markers come later.
            if (ended) break
            continue
        }
        const env = sessionEnvelope(body)
        if (env?.ev?.t === 'turn-start') {
            lastMarker = 'start'
            startedAfterPrompt = true
            // A new turn inside the window (queued prompt, another device):
            // only what follows it belongs to the latest turn.
            ended = false; status = null; error = null; texts = []
            continue
        }
        if (env?.ev?.t === 'turn-end') {
            lastMarker = 'end'
            // The previous turn closing after a queued prompt — not ours.
            if (userIndex >= 0 && emitsStarts && !startedAfterPrompt) continue
            ended = true
            status = typeof env.ev.status === 'string' ? env.ev.status : null
            error = typeof env.ev.error === 'string' ? env.ev.error : null
            continue
        }
        const piece = agentPiece(body)
        if (!piece) continue
        if (piece.kind === 'tool') texts = []
        else texts.push(piece.text)
    }

    if (userIndex < 0) ended = lastMarker === 'end'
    return {
        userSeq: userIndex >= 0 ? entries[userIndex].seq : null,
        ended,
        status: ended ? status : null,
        error: ended ? error : null,
        answer: texts.join('\n\n').trim(),
        lastSeq,
    }
}
