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
import { copyFile, rename, readFile, unlink } from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { logger } from "@/ui/logger";

export type ClaudeRewindPoint = {
    uuid: string;
    text: string;
    timestamp: number;
};

export class ForkTruncateUuidNotFoundError extends Error {
    constructor(public readonly truncateBeforeUuid: string, public readonly sourcePath: string) {
        super(`Truncation UUID ${truncateBeforeUuid} not found in ${sourcePath}`);
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
 * Copy the source JSONL to a new file under the same project dir.
 * Returns the new Claude session UUID. The file copy is atomic at the FS
 * level (single copyFile call), so concurrent writes by Claude to the
 * source do not corrupt the destination.
 */
export async function forkSession(projectDir: string, sourceClaudeSessionId: string): Promise<string> {
    const newId = randomUUID();
    const src = jsonlPath(projectDir, sourceClaudeSessionId);
    const dst = jsonlPath(projectDir, newId);

    try {
        await copyFile(src, dst);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            throw new ForkSourceMissingError(src);
        }
        throw error;
    }

    logger.debug(`[CLAUDE FORK] Forked ${sourceClaudeSessionId} -> ${newId}`);
    return newId;
}

/**
 * Stream-copy the source JSONL into a new file, stopping just before the
 * line whose `.uuid` matches `truncateBeforeUuid`. Atomic rename at the
 * end so partial writes are never visible.
 *
 * Throws `ForkTruncateUuidNotFoundError` if the marker is not found in
 * the source — we refuse to silently produce a full copy when truncation
 * was requested.
 */
export async function forkAndTruncateSession(
    projectDir: string,
    sourceClaudeSessionId: string,
    truncateBeforeUuid: string,
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

            let parsed: { uuid?: unknown } | null = null;
            try {
                parsed = JSON.parse(line);
            } catch {
                // Malformed line in the source. Carry it through verbatim;
                // claude --resume will skip it the same way it did originally.
                logger.debug(`[CLAUDE FORK] Skipped malformed JSON line during truncation copy`);
            }

            if (parsed && typeof parsed.uuid === 'string' && parsed.uuid === truncateBeforeUuid) {
                foundMarker = true;
                break;
            }

            await new Promise<void>((resolve, reject) => {
                writeStream.write(`${line}\n`, (err) => (err ? reject(err) : resolve()));
            });
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
        throw new ForkTruncateUuidNotFoundError(truncateBeforeUuid, src);
    }

    await rename(tempDst, finalDst);
    logger.debug(`[CLAUDE FORK] Forked+truncated ${sourceClaudeSessionId} -> ${newId} before ${truncateBeforeUuid}`);
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
        if (parsed?.type !== 'user') continue;
        if (parsed.isSidechain) continue;
        if (typeof parsed.uuid !== 'string' || parsed.uuid.length === 0) continue;
        const content = parsed.message?.content;
        if (typeof content !== 'string') continue;
        const trimmed = content.trim();
        if (trimmed.length === 0) continue;
        const timestampRaw = parsed.timestamp;
        const timestamp = typeof timestampRaw === 'string'
            ? Date.parse(timestampRaw)
            : (typeof timestampRaw === 'number' ? timestampRaw : Date.now());
        points.push({
            uuid: parsed.uuid,
            text: content,
            timestamp: Number.isFinite(timestamp) ? timestamp : Date.now(),
        });
    }

    return points;
}
