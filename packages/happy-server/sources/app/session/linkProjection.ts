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
import { MAX_REDACT_INPUT, MASK_LOOKAHEAD, TRUNCATED_SUFFIX, maskWithin } from './redactSecrets';

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
/** Nodes (values + keys) one record may contribute; the rest is cut and marked. */
export const MAX_RECORD_NODES = 20_000;
/** Every string / key costs at least this much text budget (empty strings and short keys are not free). */
export const MIN_STRING_COST = 16;
/** Strings shorter than this skip the secret patterns (none can match). */
const MIN_MASK_LENGTH = 8;
/** Any single string is pre-cut here before the (linear) data-URI pass. */
const HARD_STRING_CAP = 1024 * 1024;
export const TRUNCATED_MARKER = TRUNCATED_SUFFIX.trim();

/**
 * Work budget for one record. Every string and key is charged
 * max(MIN_STRING_COST, chars processed); every value/key is a node. Once a
 * budget runs out, strings become a marker and free-form containers stop
 * growing — so a record's cost is bounded however it is shaped.
 */
export class LinkBudget {
    textLeft: number;
    nodesLeft: number;
    constructor(readonly scrub: (s: string) => string, text = MAX_RECORD_TEXT, nodes = MAX_RECORD_NODES) {
        this.textLeft = text;
        this.nodesLeft = nodes;
    }
    get exhausted(): boolean { return this.textLeft <= 0 || this.nodesLeft <= 0; }
    takeNode(): boolean { this.nodesLeft--; return this.nodesLeft >= 0; }
    /** The per-string pipeline: data URIs → paths → secrets → cut (mask before cut). */
    text(input: string): string {
        if (this.textLeft <= 0) return input.length ? TRUNCATED_MARKER : input;
        const limit = Math.min(MAX_REDACT_INPUT, this.textLeft);
        this.textLeft -= Math.max(MIN_STRING_COST, Math.min(input.length, limit + MASK_LOOKAHEAD));
        if (input.length < MIN_MASK_LENGTH) return /[\\/]/.test(input) ? this.scrub(input) : input;
        let s = input.length > HARD_STRING_CAP ? input.slice(0, HARD_STRING_CAP) : input;
        s = s.replace(DATA_URI, '[image]');
        return maskWithin(s, limit, this.scrub);
    }
}

/** Set while one record is being projected (projection is synchronous). */
let active: LinkBudget | null = null;

/**
 * Tool inputs / outputs are free-form JSON chosen by the agent. Keep their
 * structure (the transcript renders it) but drop embedded images/documents
 * (object or array form), `source.type === 'base64'` payloads and data URIs.
 */
function scrubFreeform(value: unknown, depth = 0): unknown {
    if (depth > 12) return undefined;
    const budget = active;
    if (budget && !budget.takeNode()) return TRUNCATED_MARKER;
    if (typeof value === 'string') return value; // masked later with every other string value
    if (Array.isArray(value)) {
        const out: unknown[] = [];
        for (const item of value) {
            if (budget?.exhausted) { out.push(TRUNCATED_MARKER); break; }
            const next = scrubFreeform(item, depth + 1);
            if (next !== undefined) out.push(next);
        }
        return out;
    }
    if (isObj(value)) {
        if (typeof value.type === 'string' && DROP_ANY_TYPES.has(value.type)) return undefined;
        if (isObj(value.source) && value.source.type === 'base64') return undefined;
        const out: Obj = {};
        // for…in (not Object.entries): stops at the budget without materialising every key first.
        for (const k in value) {
            if (!Object.prototype.hasOwnProperty.call(value, k)) continue;
            if (budget?.exhausted) { out[uniqueKey(out, TRUNCATED_MARKER)] = TRUNCATED_MARKER; break; }
            const v = value[k];
            // A key that names a secret (password, DB_PASSWORD, apiKey, Authorization…) hides its
            // whole value, whatever the value looks like — shape-based masking cannot see "hunter2".
            const next = isSecretKey(k) ? REDACTED_VALUE : scrubFreeform(v, depth + 1);
            if (next === undefined) continue;
            // Free-form keys are agent-chosen text: scrub + mask them too, and never let
            // two keys collapse into one after rewriting.
            out[uniqueKey(out, budget ? budget.text(k) : k)] = next;
        }
        return out;
    }
    return value;
}

const REDACTED_VALUE = '[redacted]';
const SECRET_KEY_WORDS = new Set(['password', 'passwords', 'passwd', 'passphrase', 'pwd', 'secret', 'secrets', 'token', 'tokens', 'credential', 'credentials', 'auth', 'authorization', 'cookie', 'cookies', 'session', 'dsn']);
const SECRET_KEY_JOINED = /apikey|accesskey|privatekey|secretkey|clientsecret|databaseurl|connectionstring/;

/**
 * Does this free-form key name a secret? Case, `_` and `-` insensitive and
 * word based: `DB_PASSWORD`, `apiKey`, `x-api-key`, `Authorization`,
 * `sessionToken` → yes; `author`, `passage`, `tokenizer` → no.
 */
export function isSecretKey(key: string): boolean {
    if (key.length > 128) return false;
    const words = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    if (words.some((w) => SECRET_KEY_WORDS.has(w))) return true;
    return SECRET_KEY_JOINED.test(words.join(''));
}

/** A structural list cut to what the node budget still allows. */
function boundedList(list: unknown[]): unknown[] {
    if (!active) return list;
    const room = Math.max(0, Math.min(list.length, active.nodesLeft));
    active.nodesLeft -= room;
    return room < list.length ? list.slice(0, room) : list;
}

/** `key`, or `key~2`, `key~3`… — rewriting must not merge two keys. */
function uniqueKey(target: Obj, key: string): string {
    if (!Object.prototype.hasOwnProperty.call(target, key)) return key;
    for (let i = 2; ; i++) {
        const candidate = `${key}~${i}`;
        if (!Object.prototype.hasOwnProperty.call(target, candidate)) return candidate;
    }
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
                    ? boundedList(block.content).filter((c) => isObj(c) && c.type === 'text' && typeof c.text === 'string').map((c) => ({ type: 'text', text: (c as Obj).text }))
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
    if (!Array.isArray(content)) return [];
    const out: Obj[] = [];
    for (const block of content) {
        if (active && !active.takeNode()) { out.push({ type: 'text', text: TRUNCATED_MARKER }); break; }
        const projected = projectBlock(block);
        if (projected) out.push(projected);
    }
    return out;
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
        case 'queue-cancel': return Array.isArray(data.targetLocalKeys) ? { type: 'queue-cancel', targetLocalKeys: boundedList(data.targetLocalKeys).filter((k) => typeof k === 'string') } : null;
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
        case 'queue-cancel': return Array.isArray(ev.targetLocalKeys) ? { t: 'queue-cancel', targetLocalKeys: boundedList(ev.targetLocalKeys).filter((k) => typeof k === 'string') } : null;
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

/**
 * Applies the budget's text pipeline to every string VALUE. Keys are left
 * alone here: structural keys are fixed by the whitelist above, and free-form
 * keys were already rewritten (with collision suffixes) in scrubFreeform.
 */
function mapValues(value: unknown, budget: LinkBudget): unknown {
    if (typeof value === 'string') return budget.text(value);
    if (Array.isArray(value)) return value.map((v) => mapValues(v, budget));
    if (isObj(value)) {
        const out: Obj = {};
        for (const [k, v] of Object.entries(value)) out[k] = mapValues(v, budget);
        return out;
    }
    return value;
}

/**
 * One decrypted record → what an anonymous link viewer sees, or null when the
 * record is not shown at all. `scrub` is the path scrubber for the session.
 */
export function projectRecordForLink(record: unknown, scrub: (s: string) => string = makePathScrubber({}), budget: LinkBudget = new LinkBudget(scrub)): Obj | null {
    if (!isObj(record)) return null;
    active = budget;
    try {
        return projectRecord(record, budget);
    } finally {
        active = null;
    }
}

function projectRecord(record: Obj, budget: LinkBudget): Obj | null {
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
    return mapValues(out, budget) as Obj;
}

/** Title / project name for the page header: same scrub + mask. */
export function scrubLinkText(value: string, scrub: (s: string) => string): string {
    return new LinkBudget(scrub).text(value);
}

/** One page of a link transcript: also bounded as a whole (ciphertext + text + nodes across records). */
export const MAX_PAGE_TEXT = 1024 * 1024;
export const MAX_PAGE_NODES = 100_000;
/** Ciphertext a page may decrypt + parse, charged BEFORE decoding — records that project to nothing still pay. */
export const MAX_PAGE_CIPHER = 2 * 1024 * 1024;
/** A single record whose ciphertext is larger than this is never decrypted or parsed for a link. */
export const MAX_RECORD_CIPHER = 1024 * 1024;
export const OVERSIZE_TEXT = 'This message is too large to show on a share page.';

/** What the viewer sees instead of an oversize record (renders as a service line). */
export function oversizePlaceholder(id: string, time: number): Obj {
    return { role: 'session', content: { type: 'session', data: { id: `oversize-${id}`, time, role: 'agent', turn: `oversize-${id}`, ev: { t: 'service', text: OVERSIZE_TEXT } } } };
}

export interface LinkPageHooks<T> {
    /** Ciphertext length — known before any decrypt. */
    cipherLength: (record: T) => number;
    decode: (record: T) => unknown;
    /** Placeholder for a record over MAX_RECORD_CIPHER (not decrypted). */
    oversize?: (record: T) => Obj | null;
    scrub: (s: string) => string;
}

/**
 * One budgeted page. `offer()` each record in order: it first pays its
 * CIPHERTEXT length (decrypt + JSON.parse cost), then whatever its projection
 * used. Once a budget is spent `offer()` answers false and the page is done;
 * the caller pages on from the last consumed record. A page of huge records —
 * even ones that project to nothing — costs about one budget, not one per row.
 */
export class LinkPage<T> {
    private cipherLeft = MAX_PAGE_CIPHER;
    private textLeft = MAX_PAGE_TEXT;
    private nodesLeft = MAX_PAGE_NODES;
    readonly projected: Array<{ record: T; content: Obj }> = [];
    consumed = 0;
    constructor(private readonly hooks: LinkPageHooks<T>) {}

    get full(): boolean {
        return this.consumed > 0 && (this.cipherLeft <= 0 || this.textLeft <= 0 || this.nodesLeft <= 0);
    }

    /** Consume `record` (true) or refuse it because this page is spent (false). */
    offer(record: T): boolean {
        if (this.full) return false;
        const cipher = this.hooks.cipherLength(record);
        if (cipher > MAX_RECORD_CIPHER) {
            this.consumed++;
            this.cipherLeft -= MIN_STRING_COST;
            const placeholder = this.hooks.oversize?.(record);
            if (placeholder) this.projected.push({ record, content: placeholder });
            return true;
        }
        if (this.consumed > 0 && cipher > this.cipherLeft) return false; // would overrun: next page
        this.cipherLeft -= Math.max(MIN_STRING_COST, cipher);
        const budget = new LinkBudget(this.hooks.scrub, Math.min(MAX_RECORD_TEXT, Math.max(this.textLeft, MIN_STRING_COST)), Math.min(MAX_RECORD_NODES, Math.max(this.nodesLeft, 1)));
        const textStart = budget.textLeft;
        const nodesStart = budget.nodesLeft;
        const content = projectRecordForLink(this.hooks.decode(record), this.hooks.scrub, budget);
        this.textLeft -= textStart - budget.textLeft;
        this.nodesLeft -= nodesStart - budget.nodesLeft;
        this.consumed++;
        if (content) this.projected.push({ record, content });
        return true;
    }
}

/** Convenience: run a page over an in-memory list. */
export function projectLinkPage<T>(input: LinkPageHooks<T> & { records: T[] }): { projected: Array<{ record: T; content: Obj }>; consumed: number } {
    const page = new LinkPage(input);
    for (const record of input.records) if (!page.offer(record)) break;
    return { projected: page.projected, consumed: page.consumed };
}
