/**
 * List the Claude Code conversations stored on this machine (B-290).
 *
 * Claude Code — the CLI, the desktop app and SDK-driven runs alike — writes
 * every conversation to `<config>/projects/<encoded cwd>/<sessionId>.jsonl`.
 * very-happy already knows how to continue such a file (`claude-fork-session`
 * copies it, `spawn-happy-session` with `resumeClaudeSessionId` backfills it
 * into a fresh Happy session); what was missing is a way to *find* the
 * conversations that were never started through very-happy. This module is
 * the read-only scan behind the `claude-list-history` daemon RPC.
 *
 * Cost discipline: a machine easily holds hundreds of transcripts, some tens
 * of MB. We `stat` every file (cheap), order by mtime, and only read the
 * *head* (`headBytes`, default 64 KiB) of the newest candidates until `limit`
 * usable entries are found — the fields we need (cwd, first prompt, summary,
 * entrypoint, git branch) all live in the first few lines. Nothing is written.
 */
import { open, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { isVeryHappyOneShotPrompt } from './oneShotPrompts';

export type ClaudeHistoryEntry = {
    /** Claude conversation UUID (= JSONL basename). */
    claudeSessionId: string;
    /** Working directory recorded inside the transcript. */
    cwd: string;
    /** First user-typed prompt (trimmed, single line, ≤ `promptChars`). */
    firstPrompt: string;
    /** Claude Code's own summary/title line when the transcript carries one. */
    summary?: string;
    /** Timestamp of the first entry (ms since epoch). */
    startedAt: number;
    /** File mtime (ms since epoch) — last activity. */
    updatedAt: number;
    sizeBytes: number;
    /** `cli` / `sdk-cli` / `remote_mobile` / … as written by Claude Code. */
    entrypoint?: string;
    gitBranch?: string;
    /** Claude Code version that wrote the first line. */
    version?: string;
};

export type ListClaudeHistoryOptions = {
    /** Only these project directories are scanned. */
    projectDirs: string[];
    /** Max entries returned (after filtering). Default 60. */
    limit?: number;
    /** Bytes read from the head of each candidate file. Default 64 KiB. */
    headBytes?: number;
    /** Max chars kept from the first prompt / summary. Default 200. */
    promptChars?: number;
    /** Ids to skip (e.g. conversations very-happy already tracks). */
    exclude?: Iterable<string>;
};

export type ListClaudeHistoryResult = {
    entries: ClaudeHistoryEntry[];
    /** True when more usable transcripts exist beyond `limit`. */
    truncated: boolean;
    /** Number of JSONL files considered before the limit was reached. */
    scanned: number;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Sub-directories under `<config>/projects` (the per-cwd transcript dirs). */
export async function listClaudeProjectDirs(projectsRoot: string): Promise<string[]> {
    let names: string[];
    try {
        names = await readdir(projectsRoot);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
    }
    const dirs: string[] = [];
    for (const name of names) {
        const full = join(projectsRoot, name);
        try {
            if ((await stat(full)).isDirectory()) dirs.push(full);
        } catch {
            // vanished between readdir and stat — ignore
        }
    }
    return dirs;
}

type Candidate = { path: string; id: string; updatedAt: number; sizeBytes: number };

async function collectCandidates(projectDirs: string[], exclude: Set<string>): Promise<Candidate[]> {
    const out: Candidate[] = [];
    for (const dir of projectDirs) {
        let names: string[];
        try {
            names = await readdir(dir);
        } catch {
            continue; // missing / unreadable project dir is not an error for a listing
        }
        for (const name of names) {
            if (!name.endsWith('.jsonl')) continue;
            const id = name.slice(0, -'.jsonl'.length);
            if (!UUID_RE.test(id) || exclude.has(id.toLowerCase())) continue;
            const path = join(dir, name);
            try {
                const s = await stat(path);
                if (!s.isFile() || s.size === 0) continue;
                out.push({ path, id, updatedAt: s.mtimeMs, sizeBytes: s.size });
            } catch {
                // ignore races
            }
        }
    }
    out.sort((a, b) => b.updatedAt - a.updatedAt);
    // The same conversation id can exist under two project dirs (`claude
    // --resume <id>` in a different cwd writes a second file). Keep the most
    // recently touched one: two rows with one id would collide as React keys
    // and leave the import ambiguous about which file it copies.
    const seen = new Set<string>();
    return out.filter((c) => {
        const key = c.id.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
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

/**
 * Extract the listing fields from the head of one transcript. Returns null
 * when the head carries neither a user prompt nor a summary (an empty or
 * tool-only transcript is not worth importing) or no cwd (nothing to spawn
 * in). Pure: exported for tests.
 */
export function parseClaudeHistoryHead(
    head: string,
    promptChars: number,
): Omit<ClaudeHistoryEntry, 'claudeSessionId' | 'updatedAt' | 'sizeBytes'> | null {
    let cwd: string | undefined;
    let firstPrompt: string | undefined;
    let summary: string | undefined;
    let startedAt: number | null = null;
    let entrypoint: string | undefined;
    let gitBranch: string | undefined;
    let version: string | undefined;

    const lines = head.split('\n');
    // The last line of a truncated head is usually cut mid-JSON; JSON.parse
    // rejects it and we simply skip it.
    for (const line of lines) {
        if (line.length === 0) continue;
        let parsed: any;
        try { parsed = JSON.parse(line); } catch { continue; }
        if (!parsed || typeof parsed !== 'object') continue;

        if (parsed.type === 'summary' && typeof parsed.summary === 'string' && !summary) {
            const s = oneLine(parsed.summary, promptChars);
            if (s) summary = s;
            continue;
        }
        if (typeof parsed.cwd === 'string' && parsed.cwd && !cwd) cwd = parsed.cwd;
        if (typeof parsed.entrypoint === 'string' && parsed.entrypoint && !entrypoint) entrypoint = parsed.entrypoint;
        if (typeof parsed.gitBranch === 'string' && parsed.gitBranch && !gitBranch) gitBranch = parsed.gitBranch;
        if (typeof parsed.version === 'string' && parsed.version && !version) version = parsed.version;
        if (startedAt === null) startedAt = parseTimestamp(parsed.timestamp);

        if (!firstPrompt && parsed.type === 'user' && !parsed.isSidechain) {
            const content = parsed.message?.content;
            let text: string | null = null;
            if (typeof content === 'string') {
                text = content;
            } else if (Array.isArray(content)) {
                // Desktop/SDK prompts with attachments arrive as blocks; keep the
                // first text block, skip tool_result-only entries.
                const block = content.find((b: any) => b && b.type === 'text' && typeof b.text === 'string');
                if (block) text = block.text;
            }
            if (text) {
                // very-happy's own `claude -p` helpers (title generation, board
                // analysis) persist a transcript each. They are machinery, not
                // conversations — never offer them for import.
                if (isVeryHappyOneShotPrompt(text)) return null;
                const cleaned = oneLine(stripHarnessTags(text), promptChars);
                if (cleaned) firstPrompt = cleaned;
            }
        }
        if (cwd && firstPrompt && summary !== undefined && startedAt !== null) break;
    }

    if (!cwd) return null;
    if (!firstPrompt && !summary) return null;
    return {
        cwd,
        firstPrompt: firstPrompt ?? summary ?? '',
        ...(summary ? { summary } : {}),
        startedAt: startedAt ?? 0,
        ...(entrypoint ? { entrypoint } : {}),
        ...(gitBranch ? { gitBranch } : {}),
        ...(version ? { version } : {}),
    };
}

/** Drop harness envelopes (`<system-reminder>`, `<task-notification>`,
 *  `<command-name>`…) that Claude Code prepends to a typed prompt, so the
 *  listing shows what the human wrote. */
function stripHarnessTags(text: string): string {
    return text
        .replace(/<(system-reminder|task-notification|command-message|command-name|command-args|local-command-stdout|local-command-caveat)>[\s\S]*?<\/\1>/g, ' ')
        .replace(/<\/?(system-reminder|task-notification)>/g, ' ');
}

export async function listClaudeSessionHistory(options: ListClaudeHistoryOptions): Promise<ListClaudeHistoryResult> {
    const limit = Math.max(1, Math.min(options.limit ?? 60, 500));
    const headBytes = Math.max(4096, options.headBytes ?? 64 * 1024);
    const promptChars = Math.max(20, options.promptChars ?? 200);
    const exclude = new Set(Array.from(options.exclude ?? [], (id) => id.toLowerCase()));

    const candidates = await collectCandidates(options.projectDirs, exclude);
    const entries: ClaudeHistoryEntry[] = [];
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
        const parsed = parseClaudeHistoryHead(head, promptChars);
        if (!parsed) continue;
        entries.push({
            claudeSessionId: candidate.id.toLowerCase(),
            updatedAt: Math.round(candidate.updatedAt),
            sizeBytes: candidate.sizeBytes,
            ...parsed,
        });
    }
    return { entries, truncated, scanned };
}
