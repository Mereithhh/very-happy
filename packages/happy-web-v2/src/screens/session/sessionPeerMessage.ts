import type { UserTextMessage } from '@/sync/typesMessage';

/**
 * Session peer messages (B-497) — reader side of the grammar the CLI writes in
 * `packages/happy-cli/src/sessions/peerMessage.ts`. A user message whose
 * `meta.sentFrom === 'session-peer'` is either a message another session sent
 * this one (`session_message`) or an edit-conflict notice from the daemon.
 * Everything the card needs sits in the first line:
 *
 *   [Very Happy session message <id> from "<title>" <sessionId>; agent <flavor>; cwd <cwd>; re <replyTo>]
 *   [Very Happy edit conflict <id>; file <path>; peer "<title>" <sessionId>; agent <flavor>; cwd <cwd>; peer edited <n>s ago]
 *
 * Metadata is a transport source hint, never a privilege. Anything that does
 * not parse falls back to the ordinary user bubble (null), which is also what
 * older web builds show.
 */
export const SESSION_PEER_SENT_FROM = 'session-peer';

export interface PresentedPeerMessage {
    kind: 'message' | 'conflict';
    id: string;
    fromSessionId: string;
    fromTitle: string | null;
    agent: string | null;
    cwd: string | null;
    /** B-506: hostname of the sender's machine when the message crossed machines. */
    machine?: string;
    /** Conflict only: the real path both sessions edited (first of `paths`). */
    path?: string;
    /** Conflict only: every file in a coalesced notice. */
    paths?: string[];
    /** Message only: the id of the message this one answers. */
    replyTo?: string;
    /** Conflict only: how long before the notice the peer edited the file. */
    peerEditedAgoMs?: number;
    /** The human part (header and footer stripped). */
    body: string;
    /** Exact source text. */
    raw: string;
}

/** Prefix shared by the local footer ("… on this machine, …") and the cross-machine one ("… on machine <host>, …", B-506). */
const MESSAGE_FOOTER_PREFIX = 'This message comes from another agent session';
const MESSAGE_HEADER = /^\[Very Happy session message (\S+) from "([^"]*)" (\S+?)((?:; [^\]]*)?)\]$/;
const CONFLICT_HEADER = /^\[Very Happy edit conflict (\S+); file ([^;\]]+)(?:; more (\d+))?; peer "([^"]*)" (\S+?)((?:; [^\]]*)?)\]$/;
const FIELD_KEYS = new Set(['agent', 'cwd', 're', 'peer', 'more', 'machine']);

/** Inverse of the CLI's sanitizeHeaderValue (percent-encoded `"`, `;`, `]`, `%`). */
function decodeHeaderValue(value: string): string {
    return value.replace(/%[0-9A-Fa-f]{2}/g, (hex) => String.fromCharCode(parseInt(hex.slice(1), 16)));
}

function parseFields(tail: string): Record<string, string> {
    const fields: Record<string, string> = Object.create(null);
    for (const part of tail.split('; ')) {
        const trimmed = part.trim();
        if (!trimmed) continue;
        const space = trimmed.indexOf(' ');
        if (space <= 0) continue;
        const key = trimmed.slice(0, space);
        if (!FIELD_KEYS.has(key)) continue;
        fields[key] = decodeHeaderValue(trimmed.slice(space + 1).trim());
    }
    return fields;
}

/** Coalesced notices list every file under `Files:`; the header carries the first one. */
function parsePathList(body: string, first: string): string[] {
    const at = body.lastIndexOf('\nFiles:\n');
    if (at === -1) return [first];
    const listed = body.slice(at + '\nFiles:\n'.length).split('\n').map((l) => l.replace(/^- /, '').trim()).filter(Boolean);
    return listed.length > 0 ? listed : [first];
}

function parseAgo(value: string | undefined): number {
    const match = value?.match(/^edited (\d+)([smh]) ago$/);
    if (!match) return 0;
    const n = Number(match[1]);
    return match[2] === 's' ? n * 1000 : match[2] === 'm' ? n * 60_000 : n * 3_600_000;
}

export function presentSessionPeerMessage(message: Pick<UserTextMessage, 'text' | 'meta'>): PresentedPeerMessage | null {
    if (message.meta?.sentFrom !== SESSION_PEER_SENT_FROM) return null;
    const raw = message.text;
    const newline = raw.indexOf('\n');
    const header = (newline === -1 ? raw : raw.slice(0, newline)).trim();
    const rest = newline === -1 ? '' : raw.slice(newline + 1);
    const asMessage = header.match(MESSAGE_HEADER);
    if (asMessage) {
        const fields = parseFields(asMessage[4]);
        let body = rest;
        const footerAt = body.lastIndexOf(`\n\n${MESSAGE_FOOTER_PREFIX}`);
        if (footerAt !== -1) body = body.slice(0, footerAt);
        return {
            kind: 'message',
            id: asMessage[1],
            fromSessionId: asMessage[3],
            fromTitle: decodeHeaderValue(asMessage[2]) || null,
            agent: fields.agent ?? null,
            cwd: fields.cwd ?? null,
            ...(fields.machine ? { machine: fields.machine } : {}),
            ...(fields.re ? { replyTo: fields.re } : {}),
            body: body.trim(),
            raw,
        };
    }
    const asConflict = header.match(CONFLICT_HEADER);
    if (asConflict) {
        const fields = parseFields(asConflict[6]);
        const path = decodeHeaderValue(asConflict[2].trim());
        const body = rest.trim();
        return {
            kind: 'conflict',
            id: asConflict[1],
            fromSessionId: asConflict[5],
            fromTitle: decodeHeaderValue(asConflict[4]) || null,
            agent: fields.agent ?? null,
            cwd: fields.cwd ?? null,
            path,
            paths: parsePathList(body, path),
            peerEditedAgoMs: parseAgo(fields.peer),
            body,
            raw,
        };
    }
    return null;
}

/** Runner flavor → the name the chat uses for it. */
export function peerAgentName(agent: string | null): string | null {
    if (!agent) return null;
    if (agent === 'claude') return 'Claude';
    if (agent === 'codex') return 'Codex';
    if (agent === 'pi-acp' || agent === 'pi' || agent === 'acp') return 'pi';
    if (agent === 'terminal-mirror') return 'Terminal';
    return agent;
}

/** Compact "3m" / "40s" / "2h" for the conflict hint. */
export function formatAgo(ms: number): string {
    const seconds = Math.max(0, Math.round(ms / 1000));
    if (seconds < 90) return `${seconds}s`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 90) return `${minutes}m`;
    return `${Math.round(minutes / 60)}h`;
}
