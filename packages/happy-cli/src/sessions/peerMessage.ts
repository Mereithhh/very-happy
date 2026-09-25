/**
 * Session peer messages (B-497) — the text format shared by the CLI (writer)
 * and the web (reader, `happy-web-v2/src/screens/session/sessionPeerMessage.ts`).
 *
 * Two kinds of user messages carry `meta.sentFrom === 'session-peer'`:
 *
 *   - a message one session sent another (`session_message` /
 *     `very-happy sessions message`);
 *   - an edit-conflict notice the daemon sends both sessions that edited the
 *     same real path inside the window (`daemon/peerEdits.ts`).
 *
 * Like team messages, everything the reader needs is in the FIRST LINE:
 *
 *   [Very Happy session message <id> from "<title>" <sessionId>; agent <flavor>; cwd <cwd>; re <replyTo>]
 *   [Very Happy edit conflict <id>; file <path>; peer "<title>" <sessionId>; agent <flavor>; cwd <cwd>; peer edited <n>s ago]
 *
 * Fields are `; `-separated `key value` pairs; the characters that would
 * break the grammar (`"`, `;`, `]`, `%`, newlines) are percent-encoded on
 * write and decoded on read, so a path like `a;b.ts` survives. The wire
 * schema is untouched — old web builds show the header as text.
 */

export const SESSION_PEER_SENT_FROM = 'session-peer'

/** Sender id used when the message came from `very-happy sessions message` outside any session: nothing to reply to. */
export const CLI_PEER_SENDER_ID = 'cli'

export interface PeerSender {
    sessionId: string
    title?: string
    flavor?: string
    cwd?: string
    /** B-506: hostname of the machine the sender runs on, when it is not the recipient's machine. */
    machine?: string
}

export interface SessionPeerMessage {
    kind: 'message'
    id: string
    from: PeerSender
    replyTo?: string
    body: string
}

export interface EditConflictNotice {
    kind: 'conflict'
    id: string
    /** First conflicting file (the header carries one; `paths` has them all). */
    path: string
    /** Every file in this notice (coalesced within the pair window). */
    paths: string[]
    peer: PeerSender
    /** How long before the notice the peer edited the file, in ms. */
    peerEditedAgoMs: number
    body: string
}

export type ParsedPeerMessage = SessionPeerMessage | EditConflictNotice

const MESSAGE_FOOTER = 'This message comes from another agent session on this machine, not from the user.'
/** Shared prefix of the local and the cross-machine (B-506) footer — what readers strip on. */
export const MESSAGE_FOOTER_PREFIX = 'This message comes from another agent session'

function messageFooterFor(sender: PeerSender): string {
    return sender.machine
        ? `${MESSAGE_FOOTER_PREFIX} on machine ${sanitizeHeaderValue(sender.machine, 128)}, not from the user.`
        : MESSAGE_FOOTER
}

/** Percent-encode the characters that would break the one-line header grammar; collapse whitespace. */
export function sanitizeHeaderValue(value: string | undefined, max = 200): string {
    if (!value) return ''
    const collapsed = value.replace(/\s+/g, ' ').trim().slice(0, max)
    return collapsed.replace(/[%"\];]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`)
}

/** Inverse of sanitizeHeaderValue; tolerant of stray `%`. */
export function decodeHeaderValue(value: string): string {
    return value.replace(/%[0-9A-Fa-f]{2}/g, (hex) => String.fromCharCode(parseInt(hex.slice(1), 16)))
}

function senderFields(sender: PeerSender): string {
    const parts: string[] = []
    if (sender.flavor) parts.push(`agent ${sanitizeHeaderValue(sender.flavor, 32)}`)
    if (sender.cwd) parts.push(`cwd ${sanitizeHeaderValue(sender.cwd, 400)}`)
    if (sender.machine) parts.push(`machine ${sanitizeHeaderValue(sender.machine, 128)}`)
    return parts.map((part) => `; ${part}`).join('')
}

function quotedTitle(sender: PeerSender): string {
    return `"${sanitizeHeaderValue(sender.title, 120)}"`
}

export function formatSessionPeerMessage(input: { id: string; from: PeerSender; body: string; replyTo?: string }): string {
    const header = `[Very Happy session message ${input.id} from ${quotedTitle(input.from)} ${input.from.sessionId}${senderFields(input.from)}${input.replyTo ? `; re ${sanitizeHeaderValue(input.replyTo, 64)}` : ''}]`
    const base = messageFooterFor(input.from)
    const routed = input.from.machine ? ' (it is routed to that machine for you)' : ''
    const footer = input.from.sessionId === CLI_PEER_SENDER_ID
        ? `${base} It was sent from the command line (\`very-happy sessions message\`), so there is no session to reply to; act on it here.`
        : `${base} Reply with session_message(to: "${input.from.sessionId}")${routed} — or \`very-happy sessions message ${input.from.sessionId} "<text>"\` — only when you have something to add (a question, a decision, a heads-up). Do not reply just to acknowledge or thank; the exchange ends when nothing is left to coordinate.`
    return `${header}\n${input.body.trim()}\n\n${footer}`
}

export function formatDuration(ms: number): string {
    const seconds = Math.max(0, Math.round(ms / 1000))
    if (seconds < 90) return `${seconds}s`
    const minutes = Math.round(seconds / 60)
    if (minutes < 90) return `${minutes}m`
    return `${Math.round(minutes / 60)}h`
}

export function formatEditConflictNotice(input: { id: string; path: string; paths?: string[]; peer: PeerSender; peerEditedAgoMs: number; windowMs: number }): string {
    const paths = input.paths && input.paths.length > 0 ? input.paths : [input.path]
    const more = paths.length - 1
    const header = `[Very Happy edit conflict ${input.id}; file ${sanitizeHeaderValue(paths[0], 600)}${more > 0 ? `; more ${more}` : ''}; peer ${quotedTitle(input.peer)} ${input.peer.sessionId}${senderFields(input.peer)}; peer edited ${formatDuration(input.peerEditedAgoMs)} ago]`
    const window = formatDuration(input.windowMs)
    const mirror = input.peer.flavor === 'terminal-mirror'
    const what = more > 0 ? `the same ${paths.length} files` : 'the same file'
    const advice = mirror
        ? `The peer is a terminal session (agent terminal-mirror): it cannot be messaged, and the person at that terminal owns those edits — re-read the file before changing it further and keep your change minimal.`
        : `No lock is held — coordinate before continuing: session_message(to: "${input.peer.sessionId}", body: "…") saying what you are changing in ${more > 0 ? 'these files' : 'that file'} and asking what they are changing. One message that covers everything; do not send one per file.`
    const list = more > 0 ? `\nFiles:\n${paths.map((p) => `- ${p}`).join('\n')}` : ''
    return `${header}\nAnother session on this machine edited ${what} within the last ${window}. Both sessions received this notice. ${advice}${list}`
}

const MESSAGE_HEADER = /^\[Very Happy session message (\S+) from "([^"]*)" (\S+?)((?:; [^\]]*)?)\]$/
const CONFLICT_HEADER = /^\[Very Happy edit conflict (\S+); file ([^;\]]+)(?:; more \d+)?; peer "([^"]*)" (\S+?)((?:; [^\]]*)?)\]$/

const FIELD_KEYS = new Set(['agent', 'cwd', 're', 'peer', 'more', 'machine'])

function parseFields(tail: string): Record<string, string> {
    const fields: Record<string, string> = Object.create(null)
    for (const part of tail.split('; ')) {
        const trimmed = part.trim()
        if (!trimmed) continue
        const space = trimmed.indexOf(' ')
        if (space <= 0) continue
        const key = trimmed.slice(0, space)
        if (!FIELD_KEYS.has(key)) continue
        fields[key] = decodeHeaderValue(trimmed.slice(space + 1).trim())
    }
    return fields
}

/** `Files:` list in a coalesced conflict body → every path; falls back to the header path. */
function parsePathList(body: string, first: string): string[] {
    const at = body.lastIndexOf('\nFiles:\n')
    if (at === -1) return [first]
    const listed = body.slice(at + '\nFiles:\n'.length).split('\n').map((l) => l.replace(/^- /, '').trim()).filter(Boolean)
    return listed.length > 0 ? listed : [first]
}

function parseAgo(value: string | undefined): number {
    const match = value?.match(/^edited (\d+)([smh]) ago$/)
    if (!match) return 0
    const n = Number(match[1])
    return match[2] === 's' ? n * 1000 : match[2] === 'm' ? n * 60_000 : n * 3_600_000
}

/** Parse a peer message text. Returns null when the first line is not one of ours. */
export function parsePeerMessage(text: string): ParsedPeerMessage | null {
    const newline = text.indexOf('\n')
    const header = (newline === -1 ? text : text.slice(0, newline)).trim()
    const rest = newline === -1 ? '' : text.slice(newline + 1)
    const message = header.match(MESSAGE_HEADER)
    if (message) {
        const fields = parseFields(message[4])
        let body = rest
        const footerAt = body.lastIndexOf(`\n\n${MESSAGE_FOOTER_PREFIX}`)
        if (footerAt !== -1) body = body.slice(0, footerAt)
        return {
            kind: 'message',
            id: message[1],
            from: { sessionId: message[3], title: decodeHeaderValue(message[2]) || undefined, flavor: fields.agent, cwd: fields.cwd, ...(fields.machine ? { machine: fields.machine } : {}) },
            ...(fields.re ? { replyTo: fields.re } : {}),
            body: body.trim(),
        }
    }
    const conflict = header.match(CONFLICT_HEADER)
    if (conflict) {
        const fields = parseFields(conflict[5])
        const path = decodeHeaderValue(conflict[2].trim())
        const body = rest.trim()
        return {
            kind: 'conflict',
            id: conflict[1],
            path,
            paths: parsePathList(body, path),
            peer: { sessionId: conflict[4], title: decodeHeaderValue(conflict[3]) || undefined, flavor: fields.agent, cwd: fields.cwd },
            peerEditedAgoMs: parseAgo(fields.peer),
            body,
        }
    }
    return null
}
