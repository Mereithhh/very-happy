/**
 * List the Codex conversations stored on this machine (B-464).
 *
 * Codex — the `codex` TUI, `codex exec`, the Codex desktop app / IDE extension
 * and very-happy's own app-server sessions alike — writes every thread to
 * `<CODEX_HOME|~/.codex>/sessions/<yyyy>/<mm>/<dd>/rollout-<stamp>-<threadId>.jsonl`.
 * very-happy already knows how to continue a thread (`thread/fork` +
 * `thread/resume` through the app-server); what was missing is a way to *find*
 * the threads that were never started through very-happy. This module is the
 * read-only scan behind the `codex-list-history` daemon RPC — the Codex twin of
 * `claude/utils/claudeSessionHistory.ts`, and deliberately shaped like it.
 *
 * Cost discipline is the same: `stat` every rollout (cheap), order by mtime,
 * and only read the *head* of the newest candidates until `limit` usable
 * entries are found. The head is bigger here (256 KiB): a rollout opens with
 * `session_meta` (which embeds the full base instructions, ~20–35 KiB), a
 * developer message of similar size and the AGENTS.md / environment block
 * before the first real user prompt shows up. Nothing is written, and the
 * Codex sqlite state is never opened — a scan must not take the thread lock.
 */
import { open, readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type CodexHistoryEntry = {
    /** Codex thread id (UUID, = the rollout filename suffix). */
    codexThreadId: string;
    /** Working directory recorded in `session_meta`. */
    cwd: string;
    /** First user-typed prompt (trimmed, single line, ≤ `promptChars`). */
    firstPrompt: string;
    /** Thread name from `session_index.jsonl` when Codex assigned one. */
    summary?: string;
    /** `session_meta.timestamp` (ms since epoch). */
    startedAt: number;
    /** File mtime (ms since epoch) — last activity. */
    updatedAt: number;
    sizeBytes: number;
    /** `session_meta.source`: `cli` / `exec` / `vscode` / … as written by Codex. */
    entrypoint?: string;
    /** `session_meta.originator`: `codex-tui` / `codex_exec` / `Codex Desktop` / `happy-codex` … */
    originator?: string;
    gitBranch?: string;
    /** Codex CLI version that wrote the rollout. */
    version?: string;
};

export type ListCodexHistoryOptions = {
    /** `<CODEX_HOME>/sessions`. */
    sessionsRoot: string;
    /** `<CODEX_HOME>/session_index.jsonl` — optional thread names. */
    sessionIndexPath?: string;
    /** Only threads whose recorded cwd equals this directory. */
    directory?: string;
    /** Max entries returned (after filtering). Default 60. */
    limit?: number;
    /** Bytes read from the head of each candidate file. Default 256 KiB. */
    headBytes?: number;
    /** Max chars kept from the first prompt / summary. Default 200. */
    promptChars?: number;
    /** Ids to skip (e.g. threads very-happy already tracks). */
    exclude?: Iterable<string>;
};

export type ListCodexHistoryResult = {
    entries: CodexHistoryEntry[];
    /** True when more usable rollouts exist beyond `limit`. */
    truncated: boolean;
    /** Number of rollout files considered before the limit was reached. */
    scanned: number;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROLLOUT_RE = /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

/**
 * Threads very-happy started itself. Their app-server initialize handshake
 * names the client `happy-codex` (codexAppServerClient.ts) and Codex records
 * that as the rollout's `originator`; every very-happy session, fork and
 * import therefore carries it. Never offered for import: they are already
 * sessions here (or were deliberately deleted as such).
 */
export const VERY_HAPPY_CODEX_ORIGINATOR = 'happy-codex';

/** `~/.codex` (or `$CODEX_HOME`), where Codex keeps its state. */
export function getCodexHomeDir(): string {
    return process.env.CODEX_HOME || join(homedir(), '.codex');
}

export function getCodexSessionsRoot(codexHome = getCodexHomeDir()): string {
    return join(codexHome, 'sessions');
}

export function getCodexSessionIndexPath(codexHome = getCodexHomeDir()): string {
    return join(codexHome, 'session_index.jsonl');
}

type Candidate = { path: string; id: string; updatedAt: number; sizeBytes: number };

/** Walk `sessions/<yyyy>/<mm>/<dd>/rollout-*.jsonl` (tolerant of a flatter or
 *  deeper layout — any depth up to 4 is accepted). */
async function collectCandidates(root: string, exclude: Set<string>): Promise<Candidate[]> {
    const out: Candidate[] = [];
    async function walk(dir: string, depth: number): Promise<void> {
        let names: string[];
        try {
            names = await readdir(dir);
        } catch {
            return; // missing / unreadable dir is not an error for a listing
        }
        for (const name of names) {
            const full = join(dir, name);
            const match = ROLLOUT_RE.exec(name);
            if (match) {
                const id = match[1].toLowerCase();
                if (exclude.has(id)) continue;
                try {
                    const s = await stat(full);
                    if (!s.isFile() || s.size === 0) continue;
                    out.push({ path: full, id, updatedAt: s.mtimeMs, sizeBytes: s.size });
                } catch {
                    // ignore races
                }
                continue;
            }
            if (name.endsWith('.jsonl') || depth >= 4) continue;
            try {
                if ((await stat(full)).isDirectory()) await walk(full, depth + 1);
            } catch {
                // vanished between readdir and stat — ignore
            }
        }
    }
    await walk(root, 0);
    out.sort((a, b) => b.updatedAt - a.updatedAt);
    // Keep one row per thread id (a thread resumed into a new rollout file
    // would otherwise collide as a React key and leave the import ambiguous).
    const seen = new Set<string>();
    return out.filter((c) => {
        if (seen.has(c.id)) return false;
        seen.add(c.id);
        return true;
    });
}

async function readHead(path: string, bytes: number): Promise<string> {
    const fh = await open(path, 'r');
    try {
        const buffer = Buffer.alloc(bytes);
        const { bytesRead } = await fh.read(buffer, 0, bytes, 0);
        return buffer.subarray(0, bytesRead).toString('utf-8');
    } finally {
        await fh.close();
    }
}

function oneLine(text: string, max: number): string {
    const collapsed = text.replace(/\s+/g, ' ').trim();
    return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}

function parseTimestamp(raw: unknown): number | null {
    if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
    if (typeof raw === 'string') {
        const t = Date.parse(raw);
        if (Number.isFinite(t)) return t;
    }
    return null;
}

/** Codex prepends the AGENTS.md text and an environment block to the first
 *  user turn as separate user messages. They are harness, not the prompt. */
function isHarnessUserText(text: string): boolean {
    const t = text.trimStart();
    return t.startsWith('# AGENTS.md instructions')
        || t.startsWith('<environment_context>')
        || t.startsWith('<user_instructions>')
        || t.startsWith('<INSTRUCTIONS>');
}

function stripHarnessBlocks(text: string): string {
    return text
        .replace(/<(environment_context|user_instructions|INSTRUCTIONS|turn_aborted|system-reminder)>[\s\S]*?<\/\1>/g, ' ')
        .replace(/^# AGENTS\.md instructions[^\n]*\n/m, ' ');
}

function textFromUserContent(content: unknown): string | null {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return null;
    const parts: string[] = [];
    for (const part of content) {
        if (!part || typeof part !== 'object') continue;
        const type = (part as { type?: unknown }).type;
        const text = (part as { text?: unknown }).text;
        if ((type === 'input_text' || type === 'text') && typeof text === 'string') parts.push(text);
    }
    return parts.length > 0 ? parts.join('\n') : null;
}

/**
 * Extract the listing fields from the head of one rollout. Returns null when
 * the head is not a Codex rollout (no `session_meta`), carries no cwd, or holds
 * no user prompt (an empty or harness-only thread is not worth importing).
 * Pure: exported for tests.
 */
export function parseCodexHistoryHead(
    head: string,
    promptChars: number,
): Omit<CodexHistoryEntry, 'codexThreadId' | 'updatedAt' | 'sizeBytes' | 'summary'> & { id?: string } | null {
    let id: string | undefined;
    let cwd: string | undefined;
    let firstPrompt: string | undefined;
    let fallbackPrompt: string | undefined;
    let startedAt: number | null = null;
    let entrypoint: string | undefined;
    let originator: string | undefined;
    let gitBranch: string | undefined;
    let version: string | undefined;
    let sawMeta = false;

    for (const line of head.split('\n')) {
        if (line.length === 0) continue;
        let parsed: any;
        try { parsed = JSON.parse(line); } catch { continue; } // truncated tail line
        if (!parsed || typeof parsed !== 'object') continue;
        const payload = parsed.payload;

        if (parsed.type === 'session_meta' && payload && typeof payload === 'object') {
            sawMeta = true;
            if (typeof payload.id === 'string' && UUID_RE.test(payload.id)) id = payload.id.toLowerCase();
            if (typeof payload.cwd === 'string' && payload.cwd) cwd = payload.cwd;
            if (typeof payload.source === 'string' && payload.source) entrypoint = payload.source;
            if (typeof payload.originator === 'string' && payload.originator) originator = payload.originator;
            if (typeof payload.cli_version === 'string' && payload.cli_version) version = payload.cli_version;
            const branch = payload.git && typeof payload.git === 'object' ? payload.git.branch : undefined;
            if (typeof branch === 'string' && branch) gitBranch = branch;
            startedAt = parseTimestamp(payload.timestamp) ?? parseTimestamp(parsed.timestamp);
            continue;
        }
        if (!sawMeta) return null; // not a rollout file
        if (firstPrompt) break;
        if (!payload || typeof payload !== 'object') continue;

        // Newest → oldest shapes Codex has used for "what the human typed".
        if (parsed.type === 'event_msg') {
            if (payload.type === 'user_message' && typeof payload.message === 'string') {
                const cleaned = oneLine(stripHarnessBlocks(payload.message), promptChars);
                if (cleaned) firstPrompt = cleaned;
            } else if (payload.type === 'item_completed' && payload.item && payload.item.type === 'UserMessage') {
                const text = textFromUserContent(payload.item.content);
                const cleaned = text ? oneLine(stripHarnessBlocks(text), promptChars) : '';
                if (cleaned) firstPrompt = cleaned;
            }
            continue;
        }
        if (parsed.type === 'response_item' && payload.type === 'message' && payload.role === 'user' && !fallbackPrompt) {
            const text = textFromUserContent(payload.content);
            if (text && !isHarnessUserText(text)) {
                const cleaned = oneLine(stripHarnessBlocks(text), promptChars);
                if (cleaned) fallbackPrompt = cleaned;
            }
        }
    }

    if (!sawMeta || !cwd) return null;
    const prompt = firstPrompt ?? fallbackPrompt;
    if (!prompt) return null;
    return {
        ...(id ? { id } : {}),
        cwd,
        firstPrompt: prompt,
        startedAt: startedAt ?? 0,
        ...(entrypoint ? { entrypoint } : {}),
        ...(originator ? { originator } : {}),
        ...(gitBranch ? { gitBranch } : {}),
        ...(version ? { version } : {}),
    };
}

/** `session_index.jsonl`: one `{ id, thread_name, updated_at }` per line, the
 *  names Codex gave threads. Missing file → empty map. Pure over its text. */
export function parseCodexSessionIndex(text: string): Map<string, string> {
    const names = new Map<string, string>();
    for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        let parsed: any;
        try { parsed = JSON.parse(line); } catch { continue; }
        if (!parsed || typeof parsed !== 'object') continue;
        if (typeof parsed.id !== 'string' || !UUID_RE.test(parsed.id)) continue;
        if (typeof parsed.thread_name !== 'string' || !parsed.thread_name.trim()) continue;
        names.set(parsed.id.toLowerCase(), parsed.thread_name.trim());
    }
    return names;
}

async function readSessionIndex(path: string | undefined): Promise<Map<string, string>> {
    if (!path) return new Map();
    try {
        return parseCodexSessionIndex(await readFile(path, 'utf-8'));
    } catch {
        return new Map();
    }
}

export async function listCodexSessionHistory(options: ListCodexHistoryOptions): Promise<ListCodexHistoryResult> {
    const limit = Math.max(1, Math.min(options.limit ?? 60, 500));
    const headBytes = Math.max(4096, options.headBytes ?? 256 * 1024);
    const promptChars = Math.max(20, options.promptChars ?? 200);
    const exclude = new Set(Array.from(options.exclude ?? [], (id) => id.toLowerCase()));

    const [candidates, names] = await Promise.all([
        collectCandidates(options.sessionsRoot, exclude),
        readSessionIndex(options.sessionIndexPath),
    ]);
    const entries: CodexHistoryEntry[] = [];
    let scanned = 0;
    let truncated = false;
    for (const candidate of candidates) {
        if (entries.length >= limit) { truncated = true; break; }
        scanned += 1;
        let head: string;
        try {
            head = await readHead(candidate.path, headBytes);
        } catch {
            continue;
        }
        const parsed = parseCodexHistoryHead(head, promptChars);
        if (!parsed) continue;
        if (parsed.originator === VERY_HAPPY_CODEX_ORIGINATOR) continue;
        if (options.directory && parsed.cwd !== options.directory) continue;
        // The filename suffix and the recorded id agree on every rollout Codex
        // writes; trust the file's own id when both exist and differ (a copied
        // file keeps its content, not its name).
        const codexThreadId = parsed.id ?? candidate.id;
        if (exclude.has(codexThreadId)) continue;
        const { id: _id, ...rest } = parsed;
        const summary = names.get(codexThreadId);
        entries.push({
            codexThreadId,
            updatedAt: Math.round(candidate.updatedAt),
            sizeBytes: candidate.sizeBytes,
            ...rest,
            ...(summary ? { summary: oneLine(summary, promptChars) } : {}),
        });
    }
    return { entries, truncated, scanned };
}
