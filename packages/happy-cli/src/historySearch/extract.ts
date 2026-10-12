/**
 * B-549 — what the history search index keeps from one transcript line.
 *
 * Only the conversation itself is indexed: the text a person typed and the
 * text the agent answered. Tool calls, tool output, thinking/reasoning,
 * sub-agent side chains and the harness blocks the CLIs prepend to a prompt
 * are left out — they are 80–99 % of a transcript's bytes (measured
 * 2026-10-12: 570 MB of Claude transcripts hold 5 MB of conversation) and are
 * not what someone looking for "that discussion about X" types.
 *
 * Pure: every function here works on one already-split line and a mutable
 * per-file state, so the incremental reader can feed it any byte range.
 */
import { isVeryHappyOneShotPrompt } from '@/claude/utils/oneShotPrompts';
import { stripHarnessTags } from '@/claude/utils/claudeSessionHistory';
import { isCodexSubThread, isHarnessUserText, stripHarnessBlocks } from '@/codex/utils/codexSessionHistory';

export type HistorySearchAgent = 'claude' | 'codex';

/** One indexed message: role, timestamp (ms, when the line had one), text. */
export type IndexedMessage = { r: 'u' | 'a'; t?: number; x: string };

/** Why a whole file is not indexed. Recorded so the file is not re-read. */
export type SkipReason = 'one-shot' | 'subthread' | 'not-rollout';

export type DocMeta = {
    cwd?: string;
    firstPrompt?: string;
    /** Claude `type:'summary'` line / Codex `session_index.jsonl` thread name. */
    summary?: string;
    startedAt?: number;
    gitBranch?: string;
    entrypoint?: string;
    originator?: string;
    version?: string;
    /** Codex: id recorded in `session_meta` (trusted over the file name). */
    id?: string;
    /** Codex: the first line was a `session_meta`. */
    sawMeta?: boolean;
    skip?: SkipReason;
};

/** Mutable per-file extraction state. */
export type DocState = {
    meta: DocMeta;
    msgs: IndexedMessage[];
    /** Sum of `x.length` over `msgs`. */
    chars: number;
    /** The per-session cap was reached; later messages are dropped. */
    full?: boolean;
};

/** Head of one message kept (chars). A pasted log is searchable by its start. */
export const MAX_MESSAGE_CHARS = 4_000;
/** Per-session cap (chars). */
export const MAX_SESSION_CHARS = 1_000_000;
/** Title / first prompt cap (chars). */
export const MAX_TITLE_CHARS = 200;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function emptyDocState(): DocState {
    return { meta: {}, msgs: [], chars: 0 };
}

function oneLine(text: string, max: number): string {
    const collapsed = text.replace(/\s+/g, ' ').trim();
    return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}

function parseTimestamp(raw: unknown): number | undefined {
    if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
    if (typeof raw === 'string') {
        const t = Date.parse(raw);
        if (Number.isFinite(t)) return t;
    }
    return undefined;
}

/** Trim, drop blank-only text, cap the length. */
function clip(text: string): string {
    const trimmed = text.trim();
    return trimmed.length > MAX_MESSAGE_CHARS ? trimmed.slice(0, MAX_MESSAGE_CHARS) : trimmed;
}

function push(state: DocState, role: 'u' | 'a', text: string, at: number | undefined): void {
    if (state.full) return;
    const x = clip(text);
    if (!x) return;
    if (state.chars + x.length > MAX_SESSION_CHARS) {
        state.full = true;
        return;
    }
    state.msgs.push(at === undefined ? { r: role, x } : { r: role, t: at, x });
    state.chars += x.length;
}

/** Claude content: a string, or the `text` blocks of a block array (never
 *  tool_use / tool_result / thinking / images). */
function claudeText(content: unknown): string | null {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return null;
    const parts: string[] = [];
    for (const block of content) {
        if (block && typeof block === 'object' && (block as any).type === 'text' && typeof (block as any).text === 'string') {
            parts.push((block as any).text);
        }
    }
    return parts.length > 0 ? parts.join('\n') : null;
}

/** Codex `response_item.message` content parts. */
function codexText(content: unknown): string | null {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return null;
    const parts: string[] = [];
    for (const part of content) {
        if (!part || typeof part !== 'object') continue;
        const type = (part as any).type;
        const text = (part as any).text;
        if ((type === 'input_text' || type === 'output_text' || type === 'text') && typeof text === 'string') parts.push(text);
    }
    return parts.length > 0 ? parts.join('\n') : null;
}

/**
 * Cheap pre-filter before `JSON.parse`: most lines of a transcript are tool
 * traffic or token counters. A line that cannot carry indexed text is skipped
 * without parsing. Conservative — a false positive only costs a parse.
 */
export function lineMayMatter(agent: HistorySearchAgent, line: string): boolean {
    if (agent === 'claude') {
        return line.includes('"user"') || line.includes('"assistant"') || line.includes('"summary"');
    }
    return line.includes('"session_meta"') || line.includes('"message"');
}

/** Feed one Claude transcript line. */
export function extractClaudeLine(state: DocState, line: string): void {
    if (state.meta.skip || !line || !lineMayMatter('claude', line)) return;
    let parsed: any;
    try { parsed = JSON.parse(line); } catch { return; } // torn / foreign line
    if (!parsed || typeof parsed !== 'object') return;
    const meta = state.meta;

    if (parsed.type === 'summary') {
        if (typeof parsed.summary === 'string' && !meta.summary) {
            const s = oneLine(parsed.summary, MAX_TITLE_CHARS);
            if (s) meta.summary = s;
        }
        return;
    }
    if (parsed.isSidechain) return;
    if (typeof parsed.cwd === 'string' && parsed.cwd && !meta.cwd) meta.cwd = parsed.cwd;
    if (typeof parsed.gitBranch === 'string' && parsed.gitBranch && !meta.gitBranch) meta.gitBranch = parsed.gitBranch;
    if (typeof parsed.entrypoint === 'string' && parsed.entrypoint && !meta.entrypoint) meta.entrypoint = parsed.entrypoint;
    if (typeof parsed.version === 'string' && parsed.version && !meta.version) meta.version = parsed.version;
    const at = parseTimestamp(parsed.timestamp);
    if (meta.startedAt === undefined && at !== undefined) meta.startedAt = at;

    if (parsed.type !== 'user' && parsed.type !== 'assistant') return;
    const raw = claudeText(parsed.message?.content);
    if (!raw) return;
    if (parsed.type === 'user') {
        if (!meta.firstPrompt) {
            // very-happy's own `claude -p` helpers (title generation, board
            // analysis) persist a transcript each — machinery, not a conversation.
            if (isVeryHappyOneShotPrompt(raw)) {
                meta.skip = 'one-shot';
                state.msgs = [];
                state.chars = 0;
                return;
            }
        }
        const text = stripHarnessTags(raw);
        if (!meta.firstPrompt) {
            const first = oneLine(text, MAX_TITLE_CHARS);
            if (first) meta.firstPrompt = first;
        }
        push(state, 'u', text, at);
        return;
    }
    push(state, 'a', raw, at);
}

/** Feed one Codex rollout line. */
export function extractCodexLine(state: DocState, line: string): void {
    if (state.meta.skip || !line) return;
    const meta = state.meta;
    // A rollout opens with `session_meta`; anything else is not one. Decide on
    // the first line even when it fails the cheap pre-filter.
    if (!meta.sawMeta) {
        let first: any;
        try { first = JSON.parse(line); } catch { meta.skip = 'not-rollout'; return; }
        const payload = first?.payload;
        if (first?.type !== 'session_meta' || !payload || typeof payload !== 'object') {
            meta.skip = 'not-rollout';
            return;
        }
        // Codex's own sub-threads (guardian reviewer, spawned agents) are
        // machinery: B-464 hides them from import for the same reason.
        if (isCodexSubThread(payload)) {
            meta.skip = 'subthread';
            return;
        }
        meta.sawMeta = true;
        if (typeof payload.id === 'string' && UUID_RE.test(payload.id)) meta.id = payload.id.toLowerCase();
        if (typeof payload.cwd === 'string' && payload.cwd) meta.cwd = payload.cwd;
        if (typeof payload.source === 'string' && payload.source) meta.entrypoint = payload.source;
        if (typeof payload.originator === 'string' && payload.originator) meta.originator = payload.originator;
        if (typeof payload.cli_version === 'string' && payload.cli_version) meta.version = payload.cli_version;
        const branch = payload.git && typeof payload.git === 'object' ? payload.git.branch : undefined;
        if (typeof branch === 'string' && branch) meta.gitBranch = branch;
        const at = parseTimestamp(payload.timestamp) ?? parseTimestamp(first.timestamp);
        if (at !== undefined) meta.startedAt = at;
        return;
    }
    if (!lineMayMatter('codex', line)) return;
    let parsed: any;
    try { parsed = JSON.parse(line); } catch { return; }
    const payload = parsed?.payload;
    if (parsed?.type !== 'response_item' || !payload || payload.type !== 'message') return;
    if (payload.role !== 'user' && payload.role !== 'assistant') return;
    const raw = codexText(payload.content);
    if (!raw) return;
    const at = parseTimestamp(parsed.timestamp);
    if (payload.role === 'user') {
        // AGENTS.md / <environment_context> arrive as user messages; harness.
        if (isHarnessUserText(raw)) return;
        const text = stripHarnessBlocks(raw);
        if (!meta.firstPrompt) {
            const first = oneLine(text, MAX_TITLE_CHARS);
            if (first) meta.firstPrompt = first;
        }
        push(state, 'u', text, at);
        return;
    }
    push(state, 'a', raw, at);
}

export function extractLine(agent: HistorySearchAgent, state: DocState, line: string): void {
    if (agent === 'claude') extractClaudeLine(state, line);
    else extractCodexLine(state, line);
}
