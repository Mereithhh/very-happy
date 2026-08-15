/**
 * Terminal mirror (B-105) — append-only offset tail over claude transcript
 * JSONL files (spec M2).
 *
 * Unlike claude/utils/sessionScanner (which re-reads whole files and dedupes
 * by uuid — fine for normal sessions, disastrous for a 44MB hand-typed
 * transcript re-read every 3s inside the daemon event loop), this scanner
 * keeps a per-file BYTE OFFSET and only ever reads the appended region.
 * Claude transcripts are append-only (resume/fork write NEW files; the old
 * file only grows), so offsets never need to rewind — except the defensive
 * `offset > size` reset (file manually truncated/replaced), where localId
 * idempotency (M1) absorbs the replay.
 *
 * File modes:
 *  - 'backfill-tail' (first bind): read everything once, emit only the last
 *    N parsed messages (decideBackfill), offset jumps to the consumed EOF.
 *  - 'from-eof' (resume/compact continuation): the file's history prefix is
 *    server-known by construction — start at current EOF, emit only future
 *    appends. This IS `treatExistingAsProcessed` in offset form (spec risk 8:
 *    O(1), no uuid set). When the file doesn't exist yet, the first
 *    successful read starts from 0 — a resume file is created WITH its
 *    prefix in place, so by the time the watcher sees it the prefix is
 *    already on disk and 'from-eof' resolves against it (see resolveStart).
 */

import { open, stat } from 'node:fs/promises';
import { logger } from '@/ui/logger';
import { startFileWatcher } from '@/modules/watcher/startFileWatcher';
import { InvalidateSync } from '@/utils/sync';
import { RawJSONLinesSchema, type RawJSONLines } from '@/claude/types';
import { extractCompleteLines, decideBackfill } from './mirrorProtocol';

/** Internal claude events that are state tracking, not conversation (same set
 *  sessionScanner skips). */
const INTERNAL_CLAUDE_EVENT_TYPES = new Set(['file-history-snapshot', 'change', 'queue-operation']);

/** Parse the freshly-read complete lines into conversation messages. */
function parseLines(lines: string[]): RawJSONLines[] {
    const out: RawJSONLines[] = [];
    for (const line of lines) {
        try {
            const parsed = JSON.parse(line);
            if (parsed?.type && INTERNAL_CLAUDE_EVENT_TYPES.has(parsed.type)) continue;
            const result = RawJSONLinesSchema.safeParse(parsed);
            if (!result.success) continue;
            out.push(result.data);
        } catch {
            continue;
        }
    }
    return out;
}

type FileMode = 'backfill-tail' | 'from-eof';

interface FileTail {
    path: string;
    /** Next byte to read. null = start not resolved yet (first read decides
     *  per mode). */
    offset: number | null;
    mode: FileMode;
    stopWatcher: () => void;
    dead: boolean;
}

export interface MirrorScannerEvents {
    onMessages: (messages: RawJSONLines[]) => void;
    /** First-bind backfill was truncated — the caller inserts the
     *  "更早内容看终端" notice BEFORE the replayed tail. */
    onBackfillTruncated?: () => void;
    /** A watched transcript never appeared within the watcher timeout —
     *  the binding is a phantom (risk 6), caller should end it. */
    onFileGaveUp?: (path: string) => void;
}

export interface MirrorScanner {
    /** Follow one more transcript file (resume/compact chain). Idempotent per path. */
    addFile(path: string, mode: FileMode): void;
    cleanup(): Promise<void>;
}

export const MIRROR_POLL_INTERVAL_MS = 3_000;
/**
 * How long a transcript may stay absent before the watcher gives up.
 * Effectively FOREVER (setTimeout's max delay, ~24.8 days): claude does NOT
 * create the transcript until the FIRST user message, so a user who opens
 * claude and thinks for a while must not get their mirror killed (real
 * production incident: 60s default timeout ended the binding, watcher torn
 * down, mirror permanently mute + input bar refused with mirror-not-active).
 * Phantom-binding cleanup is the job of the hook/terminal lifecycle paths
 * (SessionEnd / pane observation / terminal close), never of file absence.
 */
export const MIRROR_MISSING_FILE_TIMEOUT_MS = 2 ** 31 - 1;
/** Bound watched files per binding — a long resume chain keeps only the most
 *  recent files live (older ones stopped; they were only kept because claude
 *  may still append task output to them for a short while). */
const MAX_WATCHED_FILES = 4;

export function createMirrorScanner(opts: {
    backfillLines: number;
    events: MirrorScannerEvents;
    pollIntervalMs?: number;
    missingFileTimeoutMs?: number;
}): MirrorScanner {
    // Map iteration order = insertion order → doubles as the eviction queue.
    const files = new Map<string, FileTail>();

    const readTail = async (tail: FileTail): Promise<void> => {
        if (tail.dead) return;
        let size: number;
        try {
            size = (await stat(tail.path)).size;
        } catch {
            return; // absent — the watcher will kick us when it appears
        }

        // Resolve the starting offset on first successful contact.
        if (tail.offset === null) {
            if (tail.mode === 'from-eof') {
                tail.offset = size;
                return;
            }
            tail.offset = 0; // backfill-tail: read everything once below
        }

        if (tail.offset > size) {
            logger.debug(`[MIRROR SCANNER] ${tail.path}: offset ${tail.offset} > size ${size} — file replaced, resetting (localId idempotency absorbs replays)`);
            tail.offset = 0;
        }
        if (tail.offset === size) return;

        const isFirstBackfillRead = tail.mode === 'backfill-tail' && tail.offset === 0;
        const handle = await open(tail.path, 'r');
        let buf: Buffer;
        try {
            const length = size - tail.offset;
            buf = Buffer.alloc(length);
            await handle.read(buf, 0, length, tail.offset);
        } finally {
            await handle.close();
        }

        const { lines, consumedBytes } = extractCompleteLines(buf);
        tail.offset += consumedBytes;
        if (lines.length === 0) return;
        let messages = parseLines(lines);

        if (isFirstBackfillRead) {
            const decision = decideBackfill(messages, opts.backfillLines);
            messages = decision.replay;
            if (decision.truncated) opts.events.onBackfillTruncated?.();
            // Subsequent reads of this file are plain appends.
            tail.mode = 'from-eof';
        }

        if (messages.length > 0) opts.events.onMessages(messages);
    };

    const sync = new InvalidateSync(async () => {
        for (const tail of files.values()) {
            try {
                await readTail(tail);
            } catch (error) {
                logger.debug(`[MIRROR SCANNER] read failed for ${tail.path}:`, error);
            }
        }
    });

    const interval = setInterval(() => sync.invalidate(), opts.pollIntervalMs ?? MIRROR_POLL_INTERVAL_MS);
    interval.unref?.();

    return {
        addFile(path: string, mode: FileMode): void {
            if (files.has(path)) return;
            const tail: FileTail = {
                path,
                offset: null,
                mode,
                dead: false,
                stopWatcher: startFileWatcher(path, () => sync.invalidate(), {
                    missingFileTimeoutMs: opts.missingFileTimeoutMs ?? MIRROR_MISSING_FILE_TIMEOUT_MS,
                    onGaveUp: () => {
                        tail.dead = true;
                        files.delete(path);
                        logger.debug(`[MIRROR SCANNER] transcript never appeared, dropping: ${path}`);
                        opts.events.onFileGaveUp?.(path);
                    },
                }),
            };
            files.set(path, tail);
            while (files.size > MAX_WATCHED_FILES) {
                const [evictedPath, evicted] = files.entries().next().value!;
                evicted.stopWatcher();
                evicted.dead = true;
                files.delete(evictedPath);
                logger.debug(`[MIRROR SCANNER] evicted old transcript from watch set: ${evictedPath}`);
            }
            sync.invalidate();
        },
        async cleanup(): Promise<void> {
            clearInterval(interval);
            for (const tail of files.values()) {
                tail.stopWatcher();
                tail.dead = true;
            }
            // One final drain so a fast exit doesn't lose the last appends.
            try {
                await sync.invalidateAndAwait();
            } catch (error) {
                logger.debug('[MIRROR SCANNER] final drain failed:', error);
            }
            files.clear();
            sync.stop();
        },
    };
}
