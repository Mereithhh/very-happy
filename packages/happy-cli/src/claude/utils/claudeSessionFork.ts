/**
 * Fork the on-disk Claude session JSONL so a brand-new Happy session can
 * `claude --resume <newUuid>` against a copy of the prior conversation
 * — optionally truncated at a specific user-chosen message.
 *
 * Two surfaces:
 *   - forkSession(...)             → exact copy, no truncation
 *   - forkAndTruncateSession(...)  → copy up to but excluding the line
 *                                    whose `.uuid` matches truncateBeforeUuid
 *
 * Truncation hard-fails if the UUID is not found in the source. Silently
 * returning a non-truncated copy would lie to the caller about the rewind
 * point, which is worse than failing.
 */

import { randomUUID } from "node:crypto";
import { rename, readFile, unlink, writeFile } from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { logger } from "@/ui/logger";

export type ClaudeRewindPoint = {
    uuid: string;
    text: string;
    timestamp: number;
    hasAttachments?: boolean;
};

export class ForkTruncateUuidNotFoundError extends Error {
    constructor(public readonly cutAfterUuid: string, public readonly sourcePath: string) {
        super(`Truncation UUID ${cutAfterUuid} not found in ${sourcePath}`);
        this.name = 'ForkTruncateUuidNotFoundError';
    }
}

export class ForkSourceMissingError extends Error {
    constructor(public readonly sourcePath: string) {
        super(`Source Claude session JSONL not found: ${sourcePath}`);
        this.name = 'ForkSourceMissingError';
    }
}

function jsonlPath(projectDir: string, sessionId: string): string {
    return join(projectDir, `${sessionId}.jsonl`);
}

/**
 * True for non-sidechain user-typed prompts — string content, top-level
 * conversation. Tool_result follow-ups (also `type: 'user'` but with array
 * content) and sidechain entries don't count.
 */
function isUserPrompt(parsed: any): boolean {
    if (!parsed || parsed.type !== 'user') return false;
    if (parsed.isSidechain) return false;
    const content = parsed.message?.content;
    return typeof content === 'string';
}

function hasPromptAttachments(parsed: any): boolean {
    const content = parsed.message?.content;
    return (typeof content === 'string' && content.includes('<attached_files>'))
        || (Array.isArray(content) && content.some((block: any) => block?.type !== 'text'
            || (typeof block.text === 'string' && block.text.includes('<attached_files>'))));
}

/** Text prompts may use SDK content blocks; tool results and metadata are not rewind points. */
function userPromptText(parsed: any): string | null {
    if (parsed?.type !== 'user' || parsed.isSidechain || parsed.isMeta || parsed.isSynthetic) return null;
    const content = parsed.message?.content;
    if (typeof content === 'string') return content.trim() ? content : null;
    if (!Array.isArray(content) || content.some((block) => block?.type === 'tool_result')) return null;
    const text = content
        .filter((block) => block?.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('\n');
    return text.trim() ? text : null;
}

/**
 * Delete a fork that was created for a session that never started (B-290:
 * import forks the transcript before spawning; a failed spawn would otherwise
 * leave an orphan copy that the import picker lists as a second original,
 * once per retry). Best effort: a missing file is the desired end state.
 */
export async function discardForkedSession(projectDir: string, claudeSessionId: string): Promise<void> {
    try {
        await unlink(jsonlPath(projectDir, claudeSessionId));
        logger.debug(`[CLAUDE FORK] Discarded unused fork ${claudeSessionId}`);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            logger.debug(`[CLAUDE FORK] Failed to discard fork ${claudeSessionId}:`, error);
        }
    }
}

/**
 * Copy the source JSONL to a new file under the same project dir.
 * Returns the new Claude session UUID.
 */
export async function forkSession(projectDir: string, sourceClaudeSessionId: string): Promise<string> {
    const src = jsonlPath(projectDir, sourceClaudeSessionId);
    // B-860: Claude may be appending to the source right now — copy only the
    // lines it has finished writing, never a torn last line.
    const lines = completeLines(await readSource(src));
    const newId = await writeFork(projectDir, lines);
    logger.debug(`[CLAUDE FORK] Forked ${sourceClaudeSessionId} -> ${newId}`);
    return newId;
}

async function readSource(src: string): Promise<string> {
    try {
        return await readFile(src, 'utf-8');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new ForkSourceMissingError(src);
        throw error;
    }
}

/** Write `lines` as a new session file under a fresh UUID; atomic, so a half copy is never resumable. */
async function writeFork(projectDir: string, lines: readonly string[]): Promise<string> {
    const newId = randomUUID();
    const destination = jsonlPath(projectDir, newId);
    const temporary = `${destination}.tmp-${process.pid}`;
    try {
        await writeFile(temporary, lines.length > 0 ? lines.join('\n') + '\n' : '', { encoding: 'utf-8', flag: 'wx' });
        await rename(temporary, destination);
    } catch (error) {
        await unlink(temporary).catch(() => undefined);
        throw error;
    }
    return newId;
}

/**
 * B-860: the lines of a JSONL another process may still be appending to.
 * The last segment has no newline yet; it is kept only when it already
 * parses (the writer just has not added the newline) — a torn write is not.
 */
export function completeLines(raw: string): string[] {
    const lines = raw.split('\n');
    const tail = lines.pop() ?? '';
    if (tail.trim()) {
        try { JSON.parse(tail); lines.push(tail); } catch { /* still being written */ }
    }
    return lines.filter((line) => line.length > 0);
}

const INTERRUPTED_PROMPT = /^\[Request interrupted by user(?: for tool use)?\]$/i;
const LOCAL_COMMAND_OUTPUT = /^<local-command-(?:stdout|stderr)>/;
// Assistant stops that do not end the turn: Claude continues with the tool result / server tool.
const CONTINUING_STOPS = new Set(['tool_use', 'pause_turn']);

/** True when `entry` closes a turn: the agent's final answer, an interrupt, a local command's output, a compaction. */
function endsTurn(entry: any): boolean {
    if (!entry || entry.isSidechain) return false;
    if (entry.type === 'assistant') {
        const stop = entry.message?.stop_reason;
        return typeof stop === 'string' && !CONTINUING_STOPS.has(stop);
    }
    if (entry.type === 'system' && entry.subtype === 'compact_boundary') return true;
    if (entry.type === 'user' && entry.isCompactSummary) return true;
    const text = userPromptText(entry)?.trim();
    return text !== undefined && (INTERRUPTED_PROMPT.test(text) || LOCAL_COMMAND_OUTPUT.test(text));
}

/**
 * B-860: the turn still being written at the end of a transcript — every
 * prompt after the last entry that closed a turn (a steered or mid-turn
 * delivered prompt belongs to the same turn). `null` when the transcript ends
 * on a closed turn. Only meaningful while the session is known to be running:
 * an idle transcript can end without a closing entry (a turn that died).
 */
export function findUnfinishedTurn(lines: readonly string[]): { start: number; prompts: string[] } | null {
    let start = -1;
    const prompts: string[] = [];
    for (let i = lines.length - 1; i >= 0; i--) {
        let entry: any;
        try { entry = JSON.parse(lines[i]); } catch { continue; }
        if (endsTurn(entry)) break;
        const text = userPromptText(entry);
        if (text === null || typeof entry.uuid !== 'string') continue;
        start = i;
        prompts.unshift(text);
    }
    return start < 0 ? null : { start, prompts };
}

/** Whether `lines` hold a conversation worth resuming, i.e. at least one prompt (B-851 rules). */
function conversationOf(lines: readonly string[]): { conversation: boolean; prompt: boolean } {
    let conversation = false;
    let prompt = false;
    for (const line of lines) {
        let entry: any;
        try { entry = JSON.parse(line); } catch { continue; }
        // Even a prior image-only prompt is history: never silently discard it.
        if (entry?.isSidechain || entry?.isMeta || entry?.isSynthetic || (entry?.type !== 'user' && entry?.type !== 'assistant')) continue;
        conversation = true;
        const content = entry.message?.content;
        if (entry.type === 'user' && (typeof content === 'string'
            || (Array.isArray(content) && content.length > 0 && !content.some((block: any) => block?.type === 'tool_result')))) {
            prompt = true;
        }
    }
    return { conversation, prompt };
}

export type CompletedTurnsFork =
    | { newClaudeSessionId: string; excludedPrompts: string[] }
    | { startFresh: true; excludedPrompts: string[] };

/**
 * B-860: fork a RUNNING session — every completed turn, none of the one in
 * progress (its prompts come back as `excludedPrompts` so the caller can
 * offer them again). `startFresh` = the running turn is the first one, so
 * there is nothing completed to keep. The source is only read.
 */
export async function forkCompletedTurns(projectDir: string, sourceClaudeSessionId: string): Promise<CompletedTurnsFork> {
    const src = jsonlPath(projectDir, sourceClaudeSessionId);
    const lines = completeLines(await readSource(src));
    const unfinished = findUnfinishedTurn(lines);
    const kept = unfinished ? lines.slice(0, unfinished.start) : lines;
    const excludedPrompts = unfinished?.prompts ?? [];
    const history = conversationOf(kept);
    if (!history.conversation) return { startFresh: true, excludedPrompts };
    if (!history.prompt) throw new Error('Cannot safely fork: earlier history has no user prompt');
    const newClaudeSessionId = await writeFork(projectDir, kept);
    logger.debug(`[CLAUDE FORK] Forked completed turns of ${sourceClaudeSessionId} -> ${newClaudeSessionId} (${excludedPrompts.length} prompt(s) left out)`);
    return { newClaudeSessionId, excludedPrompts };
}

/**
 * Stream-copy the source JSONL into a new file, keeping the line whose
 * `.uuid` matches `cutAfterUuid` AND every line that follows it up to —
 * but not including — the next user prompt (a non-sidechain user message
 * whose content is a plain string). Atomic rename at the end so partial
 * writes are never visible.
 *
 * Semantics: the chosen turn stays in the forked session — the user
 * message, the agent's response to it, plus any tool_use / tool_result
 * cycles that belong to that turn — and the next prompt the user typed
 * (and everything after) is dropped. The user opens the fork on a
 * complete turn and continues the conversation from there.
 *
 * Throws `ForkTruncateUuidNotFoundError` if the marker is not found in
 * the source — we refuse to silently produce a full copy when truncation
 * was requested.
 */
export async function forkAndTruncateSession(
    projectDir: string,
    sourceClaudeSessionId: string,
    cutAfterUuid: string,
): Promise<string> {
    const newId = randomUUID();
    const src = jsonlPath(projectDir, sourceClaudeSessionId);
    const finalDst = jsonlPath(projectDir, newId);
    const tempDst = `${finalDst}.tmp-${process.pid}-${Date.now()}`;

    const readStream = createReadStream(src, { encoding: 'utf-8' });
    const writeStream = createWriteStream(tempDst, { encoding: 'utf-8' });
    const rl = createInterface({ input: readStream, crlfDelay: Infinity });

    let foundMarker = false;
    let iterationError: unknown = null;
    try {
        for await (const line of rl) {
            if (line.length === 0) {
                continue;
            }

            let parsed: any = null;
            try {
                parsed = JSON.parse(line);
            } catch {
                // Malformed line in the source. Carry it through verbatim;
                // claude --resume will skip it the same way it did originally.
                logger.debug(`[CLAUDE FORK] Skipped malformed JSON line during truncation copy`);
            }

            // Once we're past the marker, the next non-sidechain user-typed
            // prompt (string content) is the cut point — that line and
            // everything after it stay out of the fork.
            if (foundMarker && parsed && isUserPrompt(parsed)) {
                break;
            }

            await new Promise<void>((resolve, reject) => {
                writeStream.write(`${line}\n`, (err) => (err ? reject(err) : resolve()));
            });

            if (!foundMarker && parsed && typeof parsed.uuid === 'string' && parsed.uuid === cutAfterUuid) {
                foundMarker = true;
            }
        }
    } catch (e) {
        iterationError = e;
    } finally {
        rl.close();
        readStream.destroy();
        await new Promise<void>((resolve, reject) => writeStream.end((err?: Error | null) => (err ? reject(err) : resolve())));
    }

    if (iterationError) {
        await unlink(tempDst).catch(() => undefined);
        if ((iterationError as NodeJS.ErrnoException).code === 'ENOENT') {
            throw new ForkSourceMissingError(src);
        }
        throw iterationError;
    }

    if (!foundMarker) {
        await unlink(tempDst).catch(() => undefined);
        throw new ForkTruncateUuidNotFoundError(cutAfterUuid, src);
    }

    await rename(tempDst, finalDst);
    logger.debug(`[CLAUDE FORK] Forked ${sourceClaudeSessionId} -> ${newId}, cut after ${cutAfterUuid}`);
    return newId;
}

/**
 * List user-text messages from a Claude JSONL — used by the app's
 * DuplicateSheet picker to populate a list of valid rewind points
 * directly from disk. The on-disk file is the source of truth: it
 * contains every message in the conversation including ones that
 * went through the legacy `sentFrom: 'web'` path on the server,
 * which never carry a claudeUuid in their session-protocol envelope.
 */
export async function listClaudeRewindPoints(
    projectDir: string,
    claudeSessionId: string,
): Promise<ClaudeRewindPoint[]> {
    const path = jsonlPath(projectDir, claudeSessionId);
    let raw: string;
    try {
        raw = await readFile(path, 'utf-8');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            throw new ForkSourceMissingError(path);
        }
        throw error;
    }

    const points: ClaudeRewindPoint[] = [];
    for (const line of raw.split('\n')) {
        if (line.length === 0) continue;
        let parsed: any;
        try { parsed = JSON.parse(line); } catch { continue; }
        const content = userPromptText(parsed);
        if (content === null) continue;
        if (typeof parsed.uuid !== 'string' || parsed.uuid.length === 0) continue;
        const timestampRaw = parsed.timestamp;
        const timestamp = typeof timestampRaw === 'string'
            ? Date.parse(timestampRaw)
            : (typeof timestampRaw === 'number' ? timestampRaw : Date.now());
        points.push({
            uuid: parsed.uuid,
            text: content,
            ...(hasPromptAttachments(parsed) ? { hasAttachments: true } : {}),
            timestamp: Number.isFinite(timestamp) ? timestamp : Date.now(),
        });
    }

    return points;
}

/** Fork only history preceding an exact top-level user UUID. Never edit the source. */
export async function forkBeforeUserMessage(
    projectDir: string, sourceClaudeSessionId: string, cutBeforeUuid: string,
): Promise<string | null> {
    const src = jsonlPath(projectDir, sourceClaudeSessionId);
    // B-860: the source may be mid-turn; a torn last line is not history yet.
    const lines = completeLines(await readSource(src));
    let cut = -1;
    for (let i = 0; i < lines.length; i++) {
        let entry: any;
        try { entry = JSON.parse(lines[i]); } catch { continue; }
        if (userPromptText(entry) !== null && entry.uuid === cutBeforeUuid) {
            if (hasPromptAttachments(entry)) throw new Error('Cannot edit and rerun a message with attachments');
            cut = i;
            break;
        }
    }
    if (cut < 0) throw new ForkTruncateUuidNotFoundError(cutBeforeUuid, src);
    const kept = lines.slice(0, cut);
    const history = conversationOf(kept);
    if (!history.conversation) return null;
    if (!history.prompt) throw new Error('Cannot safely rewind: earlier history has no user prompt');
    return writeFork(projectDir, kept);
}
