/**
 * B-549 — discover transcripts and bring the index up to date incrementally.
 *
 * Discovery mirrors the import scanners (B-290 / B-464): Claude =
 * `<config>/projects/<dir>/<uuid>.jsonl` (top level only, so `subagents/` side
 * chains are never read), Codex = `<CODEX_HOME>/sessions/<yyyy>/<mm>/<dd>/rollout-*-<uuid>.jsonl`
 * (depth ≤ 4). The roots are whatever the daemon's agent-home resolution says
 * (B-478) — the same directories the import RPCs read, so every result can be
 * imported.
 *
 * Reading is chunked and resumes at the record's `offset`; files are processed
 * one at a time with an event-loop yield in between, and a pass can be
 * cancelled (clear) at any yield point.
 */
import { open, readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { parseCodexSessionIndex } from '@/codex/utils/codexSessionHistory';
import { emptyDocState, extractLine, type DocState, type HistorySearchAgent } from './extract';
import { enforceTextCap, planFile, type FileRecord, type FileStat } from './store';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROLLOUT_RE = /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

/** Lines longer than this are skipped unparsed (base64 images, huge tool
 *  output); the cursor still moves past them. */
export const MAX_LINE_BYTES = 2 * 1024 * 1024;
const READ_CHUNK_BYTES = 1024 * 1024;

export type HistoryRoots = {
    /** `<CLAUDE_CONFIG_DIR>/projects`. */
    claudeProjectsRoot: string;
    /** `<CODEX_HOME>/sessions`. */
    codexSessionsRoot: string;
    /** `<CODEX_HOME>/session_index.jsonl` (thread names). */
    codexIndexPath: string;
};

async function statFile(path: string): Promise<{ ino: number; size: number; mtimeMs: number } | null> {
    try {
        const s = await stat(path);
        if (!s.isFile()) return null;
        return { ino: Number(s.ino) || 0, size: s.size, mtimeMs: s.mtimeMs };
    } catch {
        return null;
    }
}

async function listDir(path: string): Promise<string[]> {
    try { return await readdir(path); } catch { return []; }
}

async function isDir(path: string): Promise<boolean> {
    try { return (await stat(path)).isDirectory(); } catch { return false; }
}

/** Every Claude transcript under `projectsRoot`. */
export async function discoverClaudeFiles(projectsRoot: string): Promise<FileStat[]> {
    const out: FileStat[] = [];
    for (const dirName of await listDir(projectsRoot)) {
        const dir = join(projectsRoot, dirName);
        if (!(await isDir(dir))) continue;
        for (const name of await listDir(dir)) {
            if (!name.endsWith('.jsonl')) continue;
            const id = name.slice(0, -'.jsonl'.length);
            if (!UUID_RE.test(id)) continue;
            const path = join(dir, name);
            const s = await statFile(path);
            if (!s || s.size === 0) continue;
            out.push({ path, agent: 'claude', id: id.toLowerCase(), ...s });
        }
    }
    return out;
}

/** Every Codex rollout under `sessionsRoot` (date tree, tolerant to depth ≤ 4). */
export async function discoverCodexFiles(sessionsRoot: string): Promise<FileStat[]> {
    const out: FileStat[] = [];
    async function walk(dir: string, depth: number): Promise<void> {
        for (const name of await listDir(dir)) {
            const full = join(dir, name);
            const match = ROLLOUT_RE.exec(name);
            if (match) {
                const s = await statFile(full);
                if (s && s.size > 0) out.push({ path: full, agent: 'codex', id: match[1].toLowerCase(), ...s });
                continue;
            }
            if (name.endsWith('.jsonl') || depth >= 4) continue;
            if (await isDir(full)) await walk(full, depth + 1);
        }
    }
    await walk(sessionsRoot, 0);
    return out;
}

/**
 * Feed every complete line in `[start, EOF)` to `onLine`. Returns the offset
 * just past the last newline seen — an unterminated tail line is left for the
 * next pass. Lines over `maxLineBytes` are skipped without decoding.
 */
export async function readCompleteLines(
    path: string,
    start: number,
    onLine: (line: string) => void,
    maxLineBytes: number = MAX_LINE_BYTES,
): Promise<number> {
    const fh = await open(path, 'r');
    try {
        const buf = Buffer.allocUnsafe(READ_CHUNK_BYTES);
        let pos = start;
        let committed = start;
        let pending: Buffer[] = [];
        let pendingLen = 0;
        let skipping = false;
        for (;;) {
            const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
            if (bytesRead === 0) break;
            let i = 0;
            while (i < bytesRead) {
                const nl = buf.indexOf(10, i);
                if (nl === -1 || nl >= bytesRead) {
                    const rest = bytesRead - i;
                    if (!skipping) {
                        if (pendingLen + rest > maxLineBytes) {
                            skipping = true;
                            pending = [];
                            pendingLen = 0;
                        } else {
                            pending.push(Buffer.from(buf.subarray(i, bytesRead)));
                            pendingLen += rest;
                        }
                    }
                    break;
                }
                if (!skipping) {
                    const seg = buf.subarray(i, nl);
                    if (pendingLen + seg.length <= maxLineBytes) {
                        const line = pendingLen > 0 ? Buffer.concat([...pending, seg]).toString('utf-8') : seg.toString('utf-8');
                        onLine(line.endsWith('\r') ? line.slice(0, -1) : line);
                    }
                }
                pending = [];
                pendingLen = 0;
                skipping = false;
                committed = pos + nl + 1;
                i = nl + 1;
            }
            pos += bytesRead;
        }
        return committed;
    } finally {
        await fh.close();
    }
}

/** Build or extend one record from disk. Returns the new record (the input
 *  record is not mutated, so a cancelled pass leaves the index consistent). */
export async function indexFile(file: FileStat, prev: FileRecord | undefined, plan: 'append' | 'reread'): Promise<FileRecord> {
    const base: DocState = plan === 'append' && prev
        ? { meta: { ...prev.meta }, msgs: prev.msgs.slice(), chars: prev.chars, ...(prev.full ? { full: true } : {}) }
        : emptyDocState();
    const start = plan === 'append' && prev ? prev.offset : 0;
    let offset = start;
    if (!base.meta.skip) {
        offset = await readCompleteLines(file.path, start, (line) => extractLine(file.agent, base, line));
    } else {
        // A skipped file never becomes indexable by growing; just follow it.
        offset = file.size;
    }
    if (base.meta.skip) {
        base.msgs = [];
        base.chars = 0;
    }
    return {
        path: file.path,
        agent: file.agent,
        id: file.agent === 'codex' && base.meta.id ? base.meta.id : file.id,
        ino: file.ino,
        size: file.size,
        mtimeMs: file.mtimeMs,
        offset,
        meta: base.meta,
        msgs: base.msgs,
        chars: base.chars,
        ...(base.full ? { full: true } : {}),
    };
}

export type RefreshProgress = { filesTotal: number; filesDone: number };

export type RefreshOptions = {
    roots: HistoryRoots;
    maxTextChars: number;
    /** Return true to abandon the pass (index cleared meanwhile). */
    isCancelled?: () => boolean;
    onProgress?: (progress: RefreshProgress) => void;
    /** Called periodically during a long pass so a crash keeps the work. */
    checkpoint?: () => Promise<void>;
    checkpointEveryMs?: number;
    now?: () => number;
};

export type RefreshResult = { changed: boolean; cancelled: boolean; evicted: number; filesTotal: number };

const yieldToLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * One incremental pass over the roots. Mutates `records` file by file (each
 * replacement is a single Map.set, so a concurrent search always sees whole
 * records).
 */
export async function refreshRecords(records: Map<string, FileRecord>, options: RefreshOptions): Promise<RefreshResult> {
    const now = options.now ?? Date.now;
    const cancelled = () => options.isCancelled?.() === true;
    const [claude, codex, names] = await Promise.all([
        discoverClaudeFiles(options.roots.claudeProjectsRoot),
        discoverCodexFiles(options.roots.codexSessionsRoot),
        readFile(options.roots.codexIndexPath, 'utf-8').then(parseCodexSessionIndex, () => new Map<string, string>()),
    ]);
    if (cancelled()) return { changed: false, cancelled: true, evicted: 0, filesTotal: 0 };
    const files = [...claude, ...codex];
    // Newest first: a cold build makes recent conversations searchable first.
    files.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const total = files.length;
    let changed = false;

    // Files that vanished, or live under a root that is no longer resolved
    // (agent-home moved), leave the index.
    const present = new Set(files.map((f) => f.path));
    for (const path of [...records.keys()]) {
        if (!present.has(path)) {
            records.delete(path);
            changed = true;
        }
    }

    let done = 0;
    let lastCheckpoint = now();
    options.onProgress?.({ filesTotal: total, filesDone: 0 });
    for (const file of files) {
        if (cancelled()) return { changed, cancelled: true, evicted: 0, filesTotal: total };
        const prev = records.get(file.path);
        const plan = planFile(prev, file);
        if (plan !== 'skip') {
            try {
                const next = await indexFile(file, prev, plan);
                if (cancelled()) return { changed, cancelled: true, evicted: 0, filesTotal: total };
                records.set(file.path, next);
                changed = true;
            } catch {
                // Unreadable right now (permissions, vanished mid-read): keep the
                // previous record; the next pass retries.
            }
            await yieldToLoop();
        }
        done += 1;
        if (done % 50 === 0 || done === total) options.onProgress?.({ filesTotal: total, filesDone: done });
        if (options.checkpoint && changed && now() - lastCheckpoint >= (options.checkpointEveryMs ?? 20_000)) {
            lastCheckpoint = now();
            await options.checkpoint();
        }
    }

    // Thread names live outside the rollouts and can change at any time.
    for (const record of records.values()) {
        if (record.agent !== 'codex') continue;
        const name = names.get(record.id);
        if (name && record.meta.summary !== name) {
            record.meta = { ...record.meta, summary: name };
            changed = true;
        }
    }

    const evicted = enforceTextCap(records, options.maxTextChars);
    if (evicted > 0) changed = true;
    options.onProgress?.({ filesTotal: total, filesDone: total });
    return { changed, cancelled: false, evicted, filesTotal: total };
}
