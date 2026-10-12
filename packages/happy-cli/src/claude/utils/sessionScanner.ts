import { InvalidateSync } from "@/utils/sync";
import { RawJSONLines, RawJSONLinesSchema } from "../types";
import { join } from "node:path";
import { readTranscriptIncrement, isValidTranscriptHint, type TranscriptCursor } from "./transcriptCursor";
import { logger } from "@/ui/logger";
import { startFileWatcher } from "@/modules/watcher/startFileWatcher";
import { getProjectPath } from "./path";

/**
 * Known internal Claude Code event types that should be silently skipped.
 * These are written to session JSONL files by Claude Code but are not 
 * actual conversation messages - they're internal state/tracking events.
 */
const INTERNAL_CLAUDE_EVENT_TYPES = new Set([
    'file-history-snapshot',
    'change',
    'queue-operation',
]);

export async function createSessionScanner(opts: {
    sessionId: string | null,
    workingDirectory: string
    onMessage: (message: RawJSONLines) => void
    /**
     * How long a session transcript may stay absent before its watcher gives
     * up and the session is dropped. Defaults to the startFileWatcher default
     * (60s). Exposed mainly so tests can exercise the drop path quickly.
     */
    missingFileTimeoutMs?: number
    /**
     * B-551: the transcript path Claude itself reported for a session (the
     * SessionStart hook's `transcript_path`). Preferred over the path derived
     * from the working directory; undefined/invalid → derived path (legacy).
     */
    resolveTranscriptPath?: (sessionId: string) => string | undefined
}) {

    // Resolve project directory
    const projectDir = getProjectPath(opts.workingDirectory);

    // Finished, pending finishing and current session
    let finishedSessions = new Set<string>();
    let pendingSessions = new Set<string>();
    let currentSessionId: string | null = null;
    let watchers = new Map<string, (() => void)>();
    let processedMessageKeys = new Set<string>();
    // Sessions whose transcript file never appeared. Their watcher gave up,
    // so we must stop re-reading them and never re-create a watcher for them
    // — otherwise a phantom session id (e.g. a remote launch whose .jsonl is
    // never written) keeps itself alive forever via the watchers map below
    // and spins the CPU / floods the log (the "dead Happy instance" bug).
    let deadSessions = new Set<string>();
    // B-551: per-session read cursor (byte offset + rewrite detection) and the
    // path each watcher is attached to.
    const cursors = new Map<string, { path: string; cursor: TranscriptCursor | null }>();
    const watcherPaths = new Map<string, string>();
    /** Sessions whose existing transcript content was pre-marked as processed. */
    const premarkedSessions = new Set<string>();

    const transcriptPathFor = (sessionId: string): string => {
        const hinted = opts.resolveTranscriptPath?.(sessionId);
        return isValidTranscriptHint(sessionId, hinted) ? hinted : join(projectDir, `${sessionId}.jsonl`);
    };

    /** Messages appended since the last read of this session (all of them on
     *  the first read, or after the file was rewritten — uuid dedupe below
     *  keeps that equivalent to the old whole-file re-read). */
    const readSessionMessages = async (sessionId: string): Promise<RawJSONLines[]> => {
        const path = transcriptPathFor(sessionId);
        const state = cursors.get(sessionId);
        const pathChanged = state !== undefined && state.path !== path;
        const cursor = state && !pathChanged ? state.cursor : null;
        logger.debug(`[SESSION_SCANNER] Reading session file: ${path}`);
        const result = await readTranscriptIncrement(path, cursor);
        if (!result) {
            cursors.set(sessionId, { path, cursor: null });
            logger.debug(`[SESSION_SCANNER] Session file not found: ${path}`);
            return [];
        }
        if (result.reset) {
            logger.debug(`[SESSION_SCANNER] Transcript ${sessionId} was ${result.reset}; re-reading from the start`);
        }
        cursors.set(sessionId, { path, cursor: result.cursor });
        const messages = parseSessionLines(result.lines);
        // A session whose on-disk history was declared "already processed"
        // (initial session / treatExistingAsProcessed) keeps that meaning when
        // its hook path only arrives later: what the new path holds NOW is
        // that same history, not fresh prompts — never replay it.
        if (pathChanged && premarkedSessions.has(sessionId)) {
            logger.debug(`[SESSION_SCANNER] Transcript path for ${sessionId} changed; pre-marking ${messages.length} existing messages`);
            for (const m of messages) processedMessageKeys.add(messageKey(m));
            return [];
        }
        return messages;
    };

    // Mark existing messages as processed and start watching the initial session
    if (opts.sessionId) {
        premarkedSessions.add(opts.sessionId);
        let messages = await readSessionMessages(opts.sessionId);
        logger.debug(`[SESSION_SCANNER] Marking ${messages.length} existing messages as processed from session ${opts.sessionId}`);
        for (let m of messages) {
            processedMessageKeys.add(messageKey(m));
        }
        // IMPORTANT: Also start watching the initial session file because Claude Code
        // may continue writing to it even after creating a new session with --resume
        // (agent tasks and other updates can still write to the original session file)
        currentSessionId = opts.sessionId;
    }

    // Main sync function
    const sync = new InvalidateSync(async () => {

        // Collect session ids - include ALL sessions that have watchers
        // This ensures we continue processing sessions that Claude Code may still write to
        let sessions: string[] = [];
        for (let p of pendingSessions) {
            if (!deadSessions.has(p)) {
                sessions.push(p);
            }
        }
        if (currentSessionId && !pendingSessions.has(currentSessionId) && !deadSessions.has(currentSessionId)) {
            sessions.push(currentSessionId);
        }
        // Also process sessions that have active watchers (they may still receive updates)
        for (let [sessionId] of watchers) {
            if (!sessions.includes(sessionId) && !deadSessions.has(sessionId)) {
                sessions.push(sessionId);
            }
        }

        // Process sessions
        for (let session of sessions) {
            const sessionMessages = await readSessionMessages(session);
            let skipped = 0;
            let sent = 0;
            for (let file of sessionMessages) {
                let key = messageKey(file);
                if (processedMessageKeys.has(key)) {
                    skipped++;
                    continue;
                }
                processedMessageKeys.add(key);
                logger.debug(`[SESSION_SCANNER] Sending new message: type=${file.type}, uuid=${file.type === 'summary' ? file.leafUuid : file.uuid}`);
                opts.onMessage(file);
                sent++;
            }
            if (sessionMessages.length > 0) {
                logger.debug(`[SESSION_SCANNER] Session ${session}: found=${sessionMessages.length}, skipped=${skipped}, sent=${sent}`);
            }
        }

        // Move pending sessions to finished sessions (but keep processing them via watchers)
        for (let p of sessions) {
            if (pendingSessions.has(p)) {
                pendingSessions.delete(p);
                finishedSessions.add(p);
            }
        }

        // Update watchers for all sessions
        for (let p of sessions) {
            // B-551: a hook path that arrived after the watcher started moves it.
            const path = transcriptPathFor(p);
            if (watchers.has(p) && watcherPaths.get(p) !== path) {
                logger.debug(`[SESSION_SCANNER] Transcript path for ${p} changed; re-attaching watcher`);
                watchers.get(p)?.();
                watchers.delete(p);
                watcherPaths.delete(p);
                sync.invalidate();
            }
            if (!watchers.has(p) && !deadSessions.has(p)) {
                logger.debug(`[SESSION_SCANNER] Starting watcher for session: ${p}`);
                watcherPaths.set(p, path);
                watchers.set(p, startFileWatcher(
                    path,
                    () => { sync.invalidate(); },
                    {
                        missingFileTimeoutMs: opts.missingFileTimeoutMs,
                        onGaveUp: () => {
                            // The transcript for this session never appeared.
                            // Tear the watcher down and blacklist the session
                            // so the collection loop above stops resurrecting
                            // it. Without this the phantom session would keep
                            // itself in `watchers` forever.
                            logger.debug(`[SESSION_SCANNER] Session ${p} transcript never appeared — dropping it`);
                            watchers.get(p)?.();
                            watchers.delete(p);
                            watcherPaths.delete(p);
                            deadSessions.add(p);
                            pendingSessions.delete(p);
                        },
                    },
                ));
            }
        }
    });
    await sync.invalidateAndAwait();

    // Periodic sync
    const intervalId = setInterval(() => { sync.invalidate(); }, 3000);

    // Public interface
    return {
        cleanup: async () => {
            clearInterval(intervalId);
            for (let w of watchers.values()) {
                w();
            }
            watchers.clear();
            await sync.invalidateAndAwait();
            sync.stop();
        },
        onNewSession: async (sessionId: string, options?: { treatExistingAsProcessed?: boolean }) => {
            if (currentSessionId === sessionId) {
                logger.debug(`[SESSION_SCANNER] New session: ${sessionId} is the same as the current session, skipping`);
                return;
            }
            // The caller explicitly re-announces this session, so give a
            // previously-dropped id another chance (its file may exist now).
            if (deadSessions.delete(sessionId)) {
                logger.debug(`[SESSION_SCANNER] Reviving previously-dropped session: ${sessionId}`);
            }
            if (finishedSessions.has(sessionId)) {
                logger.debug(`[SESSION_SCANNER] New session: ${sessionId} is already finished, skipping`);
                return;
            }
            if (pendingSessions.has(sessionId)) {
                logger.debug(`[SESSION_SCANNER] New session: ${sessionId} is already pending, skipping`);
                return;
            }
            // When the caller already has these messages (typical for
            // happy-reconnect — the server holds the history from prior
            // turns and metadata.claudeSessionId simply hadn't propagated
            // by the time we built the scanner), pre-mark whatever is on
            // disk so the first invalidate() does not replay the entire
            // file as fresh user prompts. Without this, every previous
            // user message re-appears in the chat after reconnect.
            if (options?.treatExistingAsProcessed) {
                premarkedSessions.add(sessionId);
                const existing = await readSessionMessages(sessionId);
                logger.debug(`[SESSION_SCANNER] Pre-marking ${existing.length} existing messages as processed for new session ${sessionId}`);
                for (const m of existing) {
                    processedMessageKeys.add(messageKey(m));
                }
            }
            if (currentSessionId) {
                pendingSessions.add(currentSessionId);
            }
            logger.debug(`[SESSION_SCANNER] New session: ${sessionId}`)
            currentSessionId = sessionId;
            sync.invalidate();
        },
    }
}

export type SessionScanner = ReturnType<typeof createSessionScanner>;


//
// Helpers
//

function messageKey(message: RawJSONLines): string {
    if (message.type === 'user') {
        return message.uuid;
    } else if (message.type === 'assistant') {
        return message.uuid;
    } else if (message.type === 'summary') {
        return 'summary: ' + message.leafUuid + ': ' + message.summary;
    } else if (message.type === 'system') {
        return message.uuid;
    } else {
        throw Error() // Impossible
    }
}

/**
 * Parse transcript lines.
 * Returns only valid conversation messages, silently skipping internal events
 */
function parseSessionLines(lines: string[]): RawJSONLines[] {
    let messages: RawJSONLines[] = [];
    for (let l of lines) {
        try {
            if (l.trim() === '') {
                continue;
            }
            let message = JSON.parse(l);
            
            // Silently skip known internal Claude Code events
            // These are state/tracking events, not conversation messages
            if (message.type && INTERNAL_CLAUDE_EVENT_TYPES.has(message.type)) {
                continue;
            }
            
            let parsed = RawJSONLinesSchema.safeParse(message);
            if (!parsed.success) {
                // Unknown message types are silently skipped
                // They will be tracked by processedMessageKeys to avoid reprocessing
                continue;
            }
            messages.push(parsed.data);
        } catch (e) {
            logger.debug(`[SESSION_SCANNER] Error processing message: ${e}`);
            continue;
        }
    }
    return messages;
}
