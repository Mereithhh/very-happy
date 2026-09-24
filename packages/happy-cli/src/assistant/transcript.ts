/**
 * Session-log → readable transcript formatting for `session_read` — B-051.
 *
 * Input: decrypted message bodies from `/v3/sessions/:id/messages` in
 * ascending seq order. The log mixes three envelope families (see
 * apiSession.ts producers):
 *
 *   { role: 'user',    content: { type: 'text', text } }            ← user prompts
 *   { role: 'session', content: SessionEnvelope }                   ← claude protocol mapper
 *   { role: 'agent',   content: { type: 'acp', provider, data } }   ← gemini/codex ACP
 *   { role: 'agent',   content: { type: 'output', data } }          ← legacy raw claude lines
 *
 * Output: short role-tagged lines (user / assistant / [tool] …), large
 * payloads truncated — this feeds a voice assistant that needs the gist,
 * not the bytes. Pure functions; unit-tested.
 */

const MAX_LINE_CHARS = 500
const MAX_ARGS_CHARS = 160

/** Per-entry size caps. `{ full: true }` on formatTranscript lifts them (B-492 `sessions read --full`). */
export interface TranscriptLimits {
    line: number
    args: number
}
const DEFAULT_LIMITS: TranscriptLimits = { line: MAX_LINE_CHARS, args: MAX_ARGS_CHARS }
const NO_LIMITS: TranscriptLimits = { line: Number.POSITIVE_INFINITY, args: Number.POSITIVE_INFINITY }

/** Truncate to `max` code points with an ellipsis marker. */
export function truncateText(text: string, max: number = MAX_LINE_CHARS): string {
    const chars = Array.from(text)
    if (chars.length <= max) return text
    return chars.slice(0, max).join('') + ` …[+${chars.length - max} chars]`
}

/** Collapse whitespace runs so one transcript entry stays on one line-ish. */
function squash(text: string): string {
    return text.replace(/\s+/g, ' ').trim()
}

function safeJson(value: unknown, max: number): string {
    try {
        return truncateText(JSON.stringify(value) ?? '', max)
    } catch {
        return '[unserializable]'
    }
}

/**
 * Format ONE decrypted message body into a transcript line, or null when the
 * entry carries no conversational information (turn markers, tool-call-end,
 * thinking, file blobs, token counters, …).
 */
export function formatMessageBody(body: unknown, limits: TranscriptLimits = DEFAULT_LIMITS): string | null {
    if (!body || typeof body !== 'object') return null
    const b = body as Record<string, any>

    // User prompt (web / app / CLI send path).
    if (b.role === 'user' && b.content?.type === 'text' && typeof b.content.text === 'string') {
        const text = squash(b.content.text)
        return text.length > 0 ? `user: ${truncateText(text, limits.line)}` : null
    }

    // Claude protocol envelope.
    if (b.role === 'session' && b.content && typeof b.content === 'object') {
        const env = b.content as Record<string, any>
        const ev = env.ev as Record<string, any> | undefined
        if (!ev || typeof ev.t !== 'string') return null
        switch (ev.t) {
            case 'text': {
                if (ev.thinking) return null // internal reasoning — noise for a dispatcher
                const text = squash(String(ev.text ?? ''))
                if (text.length === 0) return null
                const role = env.role === 'user' ? 'user' : 'assistant'
                return `${role}: ${truncateText(text, limits.line)}`
            }
            case 'tool-call-start': {
                const name = String(ev.name ?? 'tool')
                const title = squash(String(ev.title ?? ''))
                const args = ev.args ? safeJson(ev.args, limits.args) : ''
                const detail = title || args
                return `[tool] ${name}${detail ? `: ${truncateText(detail, limits.args)}` : ''}`
            }
            case 'service': {
                const text = squash(String(ev.text ?? ''))
                return text.length > 0 ? `[service] ${truncateText(text, limits.args)}` : null
            }
            case 'turn-end': {
                if (ev.status && ev.status !== 'completed') return `[turn ${ev.status}]`
                return null
            }
            default:
                return null // turn-start / tool-call-end / file / start / stop / …
        }
    }

    // ACP agent messages (gemini / codex).
    if (b.role === 'agent' && b.content?.type === 'acp' && b.content.data && typeof b.content.data === 'object') {
        const d = b.content.data as Record<string, any>
        switch (d.type) {
            case 'message': {
                const text = squash(String(d.message ?? ''))
                return text.length > 0 ? `assistant: ${truncateText(text, limits.line)}` : null
            }
            case 'tool-call':
                return `[tool] ${String(d.name ?? 'tool')}: ${safeJson(d.input, limits.args)}`
            case 'permission-request':
                return `[permission] ${String(d.toolName ?? '')}: ${truncateText(squash(String(d.description ?? '')), limits.args)}`
            default:
                return null // reasoning / thinking / tool-result / terminal-output / lifecycle
        }
    }

    // Legacy raw claude line wrapper.
    if (b.role === 'agent' && b.content?.type === 'output') {
        const msg = b.content.data?.message
        if (msg && Array.isArray(msg.content)) {
            const texts = msg.content
                .filter((c: any) => c?.type === 'text' && typeof c.text === 'string')
                .map((c: any) => squash(c.text))
                .filter((t: string) => t.length > 0)
            if (texts.length > 0) {
                const role = msg.role === 'user' ? 'user' : 'assistant'
                return `${role}: ${truncateText(texts.join(' '), limits.line)}`
            }
        }
        return null
    }

    return null
}

/**
 * Format a batch of decrypted bodies (ascending seq order) into a transcript.
 * Undecryptable entries should be passed as null — they are skipped.
 */
export function formatTranscript(bodies: Array<unknown | null>, options: { full?: boolean } = {}): string {
    const limits = options.full ? NO_LIMITS : DEFAULT_LIMITS
    const lines: string[] = []
    for (const body of bodies) {
        const line = formatMessageBody(body, limits)
        if (line !== null) lines.push(line)
    }
    return lines.join('\n')
}
