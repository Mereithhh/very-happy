/**
 * B-701 share-link projection (spec specs/2026-10-session-sharing-tiers.md
 * §2.5): what an anonymous link viewer may see of one decrypted session
 * record. A WHITELIST per record type — every field that is not listed here
 * is dropped, so a new wire field never leaks by default. The output stays a
 * RawRecord the web renders with its normal pipeline.
 *
 * After projection every string is path-scrubbed (the session cwd becomes its
 * folder name, home directories become `~`) and secret-masked.
 */
import { MAX_REDACT_INPUT, TRUNCATED_SUFFIX, redactSecrets } from './redactSecrets';

export interface LinkProjectionContext {
    /** Session working directory (metadata.path) — rewritten to its basename. */
    cwd?: string | null;
    /** Owner home directory (metadata.homeDir) — rewritten to `~`. */
    homeDir?: string | null;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);

/** Drop undefined keys so the output is exactly the whitelisted fields that exist. */
function pick(entries: Record<string, unknown>): Obj {
    const out: Obj = {};
    for (const [k, v] of Object.entries(entries)) if (v !== undefined) out[k] = v;
    return out;
}

function escapeRe(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function basenameOf(path: string): string {
    const parts = path.split(/[\\/]+/).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : path;
}

/** Rewrites absolute locations on the owner's machine. Built once per request. */
export function makePathScrubber(ctx: LinkProjectionContext): (s: string) => string {
    const rules: Array<[RegExp, string]> = [];
    const cwd = ctx.cwd?.replace(/[\\/]+$/, '');
    if (cwd && cwd.length > 1) rules.push([new RegExp(escapeRe(cwd), 'g'), basenameOf(cwd)]);
    const home = ctx.homeDir?.replace(/[\\/]+$/, '');
    if (home && home.length > 1) rules.push([new RegExp(escapeRe(home), 'g'), '~']);
    // Any other home directory shape (another user, a different machine).
    rules.push([/\/(?:home|Users)\/[^/\s"'`]{1,64}/g, '~']);
    rules.push([/[A-Za-z]:\\Users\\[^\\\s"'`]{1,64}/g, '~']);
    return (s) => {
        let out = s;
        for (const [re, to] of rules) out = out.replace(re, to);
        return out;
    };
}

const DROP_ANY_TYPES = new Set(['thinking', 'redacted_thinking', 'image', 'document']);
/** A base64 data URI anywhere in a string (markdown image, HTML, JSON) — replaced, not just detected. */
const DATA_URI = /data:[\w.+-]{1,64}\/[\w.+-]{1,64};base64,[A-Za-z0-9+/=]*/gi;
/** Total characters one record may put through masking (a 1 MB record stays well under 200 ms). */
export const MAX_RECORD_TEXT = 256 * 1024;

/**
 * Tool inputs / outputs are free-form JSON chosen by the agent. Keep their
 * structure (the transcript renders it) but drop embedded images/documents
 * (object or array form), `source.type === 'base64'` payloads and data URIs.
 */
function scrubFreeform(value: unknown, depth = 0): unknown {
    if (depth > 12) return undefined;
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) {
        return value.map((item) => scrubFreeform(item, depth + 1)).filter((item) => item !== undefined);
    }
    if (isObj(value)) {
        if (typeof value.type === 'string' && DROP_ANY_TYPES.has(value.type)) return undefined;
        if (isObj(value.source) && value.source.type === 'base64') return undefined;
        const out: Obj = {};
        for (const [k, v] of Object.entries(value)) {
            const next = scrubFreeform(v, depth + 1);
            if (next !== undefined) out[k] = next;
        }
        return out;
    }
    return value;
}

// ------------------------------------------------------------- Claude output blocks

function projectBlock(block: unknown): Obj | undefined {
    if (!isObj(block)) return undefined;
    switch (block.type) {
        case 'text':
            return str(block.text) !== undefined ? { type: 'text', text: block.text } : undefined;
        case 'tool_use':
            return pick({ type: 'tool_use', id: str(block.id), name: str(block.name), input: scrubFreeform(block.input) ?? {} });
        case 'tool_result': {
            const content = typeof block.content === 'string'
                ? block.content
                : Array.isArray(block.content)
                    ? block.content.filter((c) => isObj(c) && c.type === 'text' && typeof c.text === 'string').map((c) => ({ type: 'text', text: (c as Obj).text }))
                    : '';
            return pick({ type: 'tool_result', tool_use_id: str(block.tool_use_id), content, is_error: bool(block.is_error) });
        }
        case 'tool-call':
            return pick({ type: 'tool-call', callId: str(block.callId), id: str(block.id), name: str(block.name), input: scrubFreeform(block.input) ?? {} });
        case 'tool-call-result':
            return pick({ type: 'tool-call-result', callId: str(block.callId), tool_use_id: str(block.tool_use_id), output: scrubFreeform(block.output) ?? '', is_error: bool(block.is_error) });
        default:
            return undefined; // thinking, image, document, anything new
    }
}

function projectBlocks(content: unknown): Obj[] {
    return Array.isArray(content) ? content.map(projectBlock).filter((b): b is Obj => !!b) : [];
}

function projectOutput(data: Obj): Obj | null {
    const common = { uuid: str(data.uuid), parentUuid: str(data.parentUuid), isSidechain: bool(data.isSidechain), parent_tool_use_id: str(data.parent_tool_use_id) };
    const message = isObj(data.message) ? data.message : null;
    switch (data.type) {
        case 'assistant': {
            if (!message) return null;
            return pick({ type: 'assistant', ...common, message: { role: 'assistant', model: str(message.model) ?? '', content: projectBlocks(message.content) } });
        }
        case 'user': {
            if (!message) return null;
            const content = typeof message.content === 'string' ? message.content : projectBlocks(message.content);
            return pick({ type: 'user', ...common, message: { role: 'user', content } });
        }
        case 'summary':
            return str(data.summary) !== undefined ? { type: 'summary', summary: data.summary } : null;
        default:
            return null; // system, result (cost / usage), anything new
    }
}

// ------------------------------------------------------------- legacy agent events / codex / acp

function projectEvent(data: Obj): Obj | null {
    switch (data.type) {
        case 'message': return str(data.message) !== undefined ? { type: 'message', message: data.message } : null;
        case 'queue-cancel': return Array.isArray(data.targetLocalKeys) ? { type: 'queue-cancel', targetLocalKeys: data.targetLocalKeys.filter((k) => typeof k === 'string') } : null;
        case 'transcript-drop': return num(data.fromSeq) !== undefined ? pick({ type: 'transcript-drop', fromSeq: data.fromSeq, toSeq: num(data.toSeq) }) : null;
        default: return null; // switch, limit-reached, ready (cost), subagent, anything new
    }
}

function projectCodex(data: Obj): Obj | null {
    switch (data.type) {
        case 'message': return str(data.message) !== undefined ? { type: 'message', message: data.message } : null;
        case 'tool-call': return pick({ type: 'tool-call', callId: str(data.callId), id: str(data.id), name: str(data.name), input: scrubFreeform(data.input) ?? {} });
        case 'tool-call-result': return pick({ type: 'tool-call-result', callId: str(data.callId), id: str(data.id), output: scrubFreeform(data.output) ?? '' });
        default: return null; // reasoning, anything new
    }
}

function projectAcp(data: Obj): Obj | null {
    switch (data.type) {
        case 'message': return str(data.message) !== undefined ? { type: 'message', message: data.message } : null;
        case 'tool-call': return pick({ type: 'tool-call', callId: str(data.callId), id: str(data.id), name: str(data.name), input: scrubFreeform(data.input) ?? {} });
        case 'tool-result': return pick({ type: 'tool-result', callId: str(data.callId), id: str(data.id), output: scrubFreeform(data.output) ?? '', isError: bool(data.isError) });
        case 'tool-call-result': return pick({ type: 'tool-call-result', callId: str(data.callId), id: str(data.id), output: scrubFreeform(data.output) ?? '' });
        case 'file-edit': return pick({ type: 'file-edit', id: str(data.id), description: str(data.description) ?? '', filePath: str(data.filePath) ?? '', diff: str(data.diff) });
        case 'terminal-output': return pick({ type: 'terminal-output', callId: str(data.callId), data: str(data.data) ?? '' });
        case 'task_started': case 'task_complete': case 'turn_aborted': return pick({ type: data.type, id: str(data.id) });
        default: return null; // reasoning, thinking, permission-request, token_count, anything new
    }
}

// ------------------------------------------------------------- structured session envelopes

function projectEnvelopeEvent(ev: Obj): Obj | null {
    switch (ev.t) {
        case 'text': return ev.thinking ? null : (str(ev.text) !== undefined ? { t: 'text', text: ev.text } : null);
        case 'service': return str(ev.text) !== undefined ? { t: 'service', text: ev.text } : null;
        case 'tool-call-start': return pick({ t: 'tool-call-start', call: str(ev.call), name: str(ev.name), title: str(ev.title) ?? '', description: str(ev.description) ?? '', args: isObj(ev.args) ? scrubFreeform(ev.args) : {} });
        case 'tool-call-end': {
            const result = isObj(ev.result) ? pick({ text: str(ev.result.text) ?? '', truncated: bool(ev.result.truncated), isError: bool(ev.result.isError) }) : undefined;
            return pick({ t: 'tool-call-end', call: str(ev.call), result });
        }
        case 'turn-start': return { t: 'turn-start' };
        case 'start': return pick({ t: 'start', title: str(ev.title), description: str(ev.description), subagentType: str(ev.subagentType) });
        case 'turn-end': return pick({ t: 'turn-end', status: str(ev.status) ?? 'completed', error: str(ev.error) }); // no cost / usage / duration
        case 'stop': return pick({ t: 'stop', status: str(ev.status), result: isObj(ev.result) ? pick({ text: str(ev.result.text) ?? '', truncated: bool(ev.result.truncated) }) : undefined });
        case 'progress': return pick({ t: 'progress', toolUses: num(ev.toolUses) ?? 0, lastTool: str(ev.lastTool) });
        case 'queue-cancel': return Array.isArray(ev.targetLocalKeys) ? { t: 'queue-cancel', targetLocalKeys: ev.targetLocalKeys.filter((k) => typeof k === 'string') } : null;
        case 'transcript-drop': return num(ev.fromSeq) !== undefined ? pick({ t: 'transcript-drop', fromSeq: ev.fromSeq, toSeq: num(ev.toSeq) }) : null;
        default: return null; // file (attachments / images), anything new
    }
}

function projectEnvelope(envelope: unknown): Obj | null {
    if (!isObj(envelope) || !isObj(envelope.ev)) return null;
    const ev = projectEnvelopeEvent(envelope.ev);
    if (!ev) return null;
    return pick({ id: str(envelope.id), time: num(envelope.time), role: str(envelope.role), turn: str(envelope.turn), subagent: str(envelope.subagent), ev });
}

// ------------------------------------------------------------- record

function projectAgentContent(content: unknown): Obj | null {
    if (!isObj(content) || !isObj(content.data)) return null;
    let data: Obj | null;
    switch (content.type) {
        case 'output': data = projectOutput(content.data); break;
        case 'event': data = projectEvent(content.data); return data ? pick({ type: 'event', id: str(content.id), data }) : null;
        case 'codex': data = projectCodex(content.data); break;
        case 'acp': data = projectAcp(content.data); return data ? { type: 'acp', provider: str(content.provider) ?? 'claude', data } : null;
        case 'session': data = projectEnvelope(content.data); break;
        default: return null;
    }
    return data ? { type: content.type, data } : null;
}

/** Applies `fn` to every string value AND every object key (keys are agent-chosen in free-form JSON). */
function mapStrings(value: unknown, fn: (s: string) => string): unknown {
    if (typeof value === 'string') return fn(value);
    if (Array.isArray(value)) return value.map((v) => mapStrings(v, fn));
    if (isObj(value)) {
        const out: Obj = {};
        for (const [k, v] of Object.entries(value)) out[fn(k)] = mapStrings(v, fn);
        return out;
    }
    return value;
}

/**
 * The per-string pipeline for link output, with a per-record character budget:
 * cap → strip data URIs → rewrite paths → mask secrets. Once the record has
 * spent MAX_RECORD_TEXT characters, further strings are cut to a marker, so
 * the work per record is bounded no matter how large it is.
 */
export function makeLinkTextFilter(scrub: (s: string) => string, budget = MAX_RECORD_TEXT): (s: string) => string {
    let remaining = budget;
    return (input) => {
        if (remaining <= 0) return input.length ? TRUNCATED_SUFFIX.trim() : input;
        const limit = Math.min(MAX_REDACT_INPUT, remaining);
        let s = input.length > limit ? input.slice(0, limit) + TRUNCATED_SUFFIX : input;
        remaining -= Math.min(input.length, limit);
        s = s.replace(DATA_URI, '[image]');
        return redactSecrets(scrub(s));
    };
}

/**
 * One decrypted record → what an anonymous link viewer sees, or null when the
 * record is not shown at all. `scrub` is the path scrubber for the session.
 */
export function projectRecordForLink(record: unknown, scrub: (s: string) => string = makePathScrubber({})): Obj | null {
    if (!isObj(record)) return null;
    let content: Obj | null;
    if (record.role === 'user') {
        content = isObj(record.content) && record.content.type === 'text' && typeof record.content.text === 'string'
            ? { type: 'text', text: record.content.text }
            : null;
    } else if (record.role === 'agent') {
        content = projectAgentContent(record.content);
    } else if (record.role === 'session') {
        const envelope = isObj(record.content) ? projectEnvelope(record.content.data) : null;
        content = envelope ? { type: 'session', data: envelope } : null;
    } else {
        content = null;
    }
    if (!content) return null;
    const out: Obj = { role: record.role, content };
    if (isObj(record.meta)) {
        const meta = record.meta;
        const shared = isObj(meta.sharedBy) ? str(meta.sharedBy.displayName) : undefined;
        const safeMeta = pick({ sentFrom: str(meta.sentFrom), displayText: str(meta.displayText), sharedBy: shared !== undefined ? { accountId: 'shared', displayName: shared } : undefined });
        if (Object.keys(safeMeta).length > 0) out.meta = safeMeta;
    }
    return mapStrings(out, makeLinkTextFilter(scrub)) as Obj;
}

/** Title / project name for the page header: same scrub + mask. */
export function scrubLinkText(value: string, scrub: (s: string) => string): string {
    return makeLinkTextFilter(scrub)(value);
}
