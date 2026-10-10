/**
 * In-place conversation rewind for a live Claude session (B-528).
 *
 * The web edits or deletes one of the user's own messages; the wrapper writes
 * a NEW Claude JSONL that no longer contains it and resumes from that file:
 *
 *   - `edit`   → keep only the history BEFORE the target prompt. The web then
 *                sends the edited text as the next prompt, so the old prompt and
 *                everything after it are replaced.
 *   - `delete` → drop the target prompt's turn (the prompt plus every entry up
 *                to the next top-level user prompt) and keep what follows; the
 *                first kept entry after the gap is re-parented onto the target's
 *                parent so the chain stays linear.
 *
 * The source JSONL is never modified — rolling back is pointing the session at
 * the old id. File edits made by the dropped turns are NOT reverted.
 *
 * Target resolution is exact-first: since B-528 the wrapper passes the web
 * message's localId as the SDK user-message `uuid`, so the prompt entry's
 * `uuid` IS the web localId. Older prompts (sent before that) fall back to a
 * UNIQUE exact text match; anything ambiguous fails instead of guessing.
 *
 * B-544 lineage: when the target is not in the current file but is in the file
 * it was copied from (an earlier rewind the web never confirmed), rewind from
 * that source instead — a retried edit succeeds from any leftover state.
 */

import { randomUUID } from 'node:crypto';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ForkSourceMissingError } from './claudeSessionFork';

export type ConversationRewindAction = 'edit' | 'delete';

export class ConversationRewindError extends Error {
    constructor(public readonly code: 'not-found' | 'ambiguous' | 'unsafe', message: string) {
        super(message);
        this.name = 'ConversationRewindError';
    }
}

type Entry = { line: string; parsed: any };

/** Top-level prompt the user typed (string or text blocks; not a tool result / meta / sidechain). */
export function transcriptPromptText(parsed: any): string | null {
    if (parsed?.type !== 'user' || parsed.isSidechain || parsed.isMeta || parsed.isSynthetic) return null;
    const content = parsed.message?.content;
    if (typeof content === 'string') return content.trim() ? content : null;
    if (!Array.isArray(content) || content.some((block: any) => block?.type === 'tool_result')) return null;
    const text = content
        .filter((block: any) => block?.type === 'text' && typeof block.text === 'string')
        .map((block: any) => block.text)
        .join('\n');
    // An image-only prompt is still a prompt boundary.
    if (!text.trim()) return content.length > 0 ? '' : null;
    return text;
}

function isConversationEntry(parsed: any): boolean {
    return !parsed?.isSidechain && !parsed?.isMeta && !parsed?.isSynthetic
        && (parsed?.type === 'user' || parsed?.type === 'assistant');
}

/**
 * Index of the prompt entry to rewind. `uuids` are the candidate ids in
 * preference order (the web localId, then any batch alias the wrapper knows).
 */
export function resolveRewindTarget(entries: readonly Entry[], target: { uuids: readonly string[]; text?: string }): number {
    for (const uuid of target.uuids) {
        const index = entries.findIndex((entry) => entry.parsed?.uuid === uuid && transcriptPromptText(entry.parsed) !== null);
        if (index >= 0) return index;
    }
    const wanted = target.text?.trim();
    if (!wanted) throw new ConversationRewindError('not-found', 'This message is not in the agent conversation');
    const matches: number[] = [];
    entries.forEach((entry, index) => {
        if (transcriptPromptText(entry.parsed)?.trim() === wanted) matches.push(index);
    });
    if (matches.length === 1) return matches[0];
    if (matches.length === 0) throw new ConversationRewindError('not-found', 'This message is not in the agent conversation');
    throw new ConversationRewindError('ambiguous', 'Several earlier messages have the same text; cannot tell which one to change');
}

/** Pure core: the kept lines for `action`, or null when nothing of the conversation would remain. */
export function rewindTranscriptLines(lines: readonly string[], action: ConversationRewindAction, target: { uuids: readonly string[]; text?: string }): string[] | null {
    const entries: Entry[] = [];
    for (const line of lines) {
        if (!line) continue;
        let parsed: any = null;
        try { parsed = JSON.parse(line); } catch { /* carried verbatim */ }
        entries.push({ line, parsed });
    }
    const cut = resolveRewindTarget(entries, target);
    let end = entries.length;
    for (let i = cut + 1; i < entries.length; i++) {
        if (transcriptPromptText(entries[i].parsed) !== null) { end = i; break; }
    }
    const before = entries.slice(0, cut);
    const after = action === 'delete' ? entries.slice(end) : [];
    if (![...before, ...after].some((entry) => isConversationEntry(entry.parsed))) return null;
    if (before.some((entry) => isConversationEntry(entry.parsed))
        && !before.some((entry) => transcriptPromptText(entry.parsed) !== null)) {
        throw new ConversationRewindError('unsafe', 'Cannot safely rewind: earlier history has no user prompt');
    }
    if (after.length === 0) return before.map((entry) => entry.line);

    const dropped = new Set<string>();
    for (const entry of entries.slice(cut, end)) {
        if (typeof entry.parsed?.uuid === 'string') dropped.add(entry.parsed.uuid);
    }
    const reparentTo: string | null = typeof entries[cut].parsed?.parentUuid === 'string' ? entries[cut].parsed.parentUuid : null;
    const relinked = after.map((entry) => {
        const parsed = entry.parsed;
        if (!parsed || typeof parsed !== 'object') return entry.line;
        let next = parsed;
        for (const key of ['parentUuid', 'logicalParentUuid'] as const) {
            if (typeof parsed[key] === 'string' && dropped.has(parsed[key])) {
                next = next === parsed ? { ...parsed } : next;
                next[key] = reparentTo;
            }
        }
        return next === parsed ? entry.line : JSON.stringify(next);
    });
    return [...before.map((entry) => entry.line), ...relinked];
}

/**
 * The file a rewound copy was made from: copied rows keep their original
 * `sessionId`, so the newest row naming another id is the source. Null for an
 * original conversation.
 */
export function transcriptSourceId(lines: readonly string[], claudeSessionId: string): string | null {
    let source: string | null = null;
    for (const line of lines) {
        if (!line || !line.includes('"sessionId"')) continue;
        let parsed: any;
        try { parsed = JSON.parse(line); } catch { continue; }
        if (typeof parsed?.sessionId === 'string' && parsed.sessionId && parsed.sessionId !== claudeSessionId) source = parsed.sessionId;
    }
    return source;
}

/** How many copies back a rewind target is looked up (B-544). */
const MAX_LINEAGE_DEPTH = 4;

async function readTranscriptLines(projectDir: string, claudeSessionId: string): Promise<string[]> {
    const path = join(projectDir, `${claudeSessionId}.jsonl`);
    try {
        return (await readFile(path, 'utf-8')).split('\n');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new ForkSourceMissingError(path);
        throw error;
    }
}

/**
 * Pure lineage walk: the kept lines from the newest file in the chain that
 * contains the target. `load(id)` returns a file's lines or null when missing.
 */
export async function rewindAcrossLineage(
    load: (claudeSessionId: string) => Promise<string[] | null>,
    claudeSessionId: string,
    action: ConversationRewindAction,
    target: { uuids: readonly string[]; text?: string },
): Promise<{ kept: string[] | null; from: string }> {
    let id = claudeSessionId;
    let lines = await load(id);
    if (!lines) throw new ForkSourceMissingError(id);
    for (let depth = 0; ; depth++) {
        try {
            return { kept: rewindTranscriptLines(lines, action, target), from: id };
        } catch (error) {
            if (!(error instanceof ConversationRewindError) || error.code !== 'not-found' || depth >= MAX_LINEAGE_DEPTH) throw error;
            const source = transcriptSourceId(lines, id);
            const sourceLines = source ? await load(source) : null;
            if (!source || !sourceLines) throw error;
            id = source;
            lines = sourceLines;
        }
    }
}

/**
 * Write the rewound conversation as a new Claude session file. Returns its id,
 * or null when nothing would remain (the caller starts a fresh conversation).
 */
export async function rewindClaudeTranscript(
    projectDir: string,
    claudeSessionId: string,
    action: ConversationRewindAction,
    target: { uuids: readonly string[]; text?: string },
): Promise<string | null> {
    const { kept } = await rewindAcrossLineage(async (id) => {
        if (id === claudeSessionId) return readTranscriptLines(projectDir, id);
        return readTranscriptLines(projectDir, id).catch((error) => {
            if (error instanceof ForkSourceMissingError) return null;
            throw error;
        });
    }, claudeSessionId, action, target);
    if (kept === null) return null;
    const newId = randomUUID();
    const destination = join(projectDir, `${newId}.jsonl`);
    const temporary = `${destination}.tmp-${process.pid}`;
    try {
        await writeFile(temporary, kept.join('\n') + '\n', { encoding: 'utf-8', flag: 'wx' });
        await rename(temporary, destination);
    } catch (error) {
        await unlink(temporary).catch(() => undefined);
        throw error;
    }
    return newId;
}
