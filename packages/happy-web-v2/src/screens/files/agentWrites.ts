/**
 * B-573: has the agent written THIS file since the preview loaded it?
 *
 * Pure. The signal is the session's own completed write-tool events (Claude
 * Edit/MultiEdit/Write/NotebookEdit, Codex patches, pi edit/write via the
 * Claude-shaped mapping; sub-agent children included) — never a file-system
 * poll. Spec: specs/2026-10-change-review-surfaces.md
 */
import type { Message } from '@/sync/typesMessage';
import { resolveAgainstCwd } from '../session/toolFilePath';
import { walkToolCalls, writtenPathsOf } from '../session/turnDiffs';

/**
 * Resolve against cwd, expand `~` with the session's home when known (review
 * 低5; unknown home → `~` stays literal), then fold `.`/`..`/`//` so tool
 * paths and viewer paths compare equal. Case-insensitive file systems and
 * symlinks are NOT folded (see spec) — a different spelling of the same file
 * simply does not trigger a refresh.
 */
export function normalizeAbsPath(path: string, cwd: string | null | undefined, home?: string | null): string {
    let p = path.replace(/\\/g, '/');
    if (home && (p === '~' || p.startsWith('~/'))) p = home.replace(/\/+$/, '') + p.slice(1);
    const resolved = resolveAgainstCwd(p, cwd);
    const absolute = resolved.startsWith('/');
    const out: string[] = [];
    for (const part of resolved.split('/')) {
        if (part === '' || part === '.') continue;
        if (part === '..') {
            if (out.length > 0 && out[out.length - 1] !== '..') out.pop();
            else if (!absolute) out.push('..');
            continue;
        }
        out.push(part);
    }
    return (absolute ? '/' : '') + out.join('/');
}

type WriteEntries = { key: string; writes: Array<[path: string, at: number]> };
// Per message object: a streaming session re-renders on every message, but
// only new/changed message objects are re-walked (review 低3).
const entryCache = new WeakMap<Message, WriteEntries>();

function writesOf(message: Message, cwd: string | null | undefined, home: string | null | undefined): Array<[string, number]> {
    const key = `${cwd ?? ''}\u0000${home ?? ''}`;
    const hit = entryCache.get(message);
    if (hit && hit.key === key) return hit.writes;
    const writes: Array<[string, number]> = [];
    for (const tool of walkToolCalls([message])) {
        for (const path of writtenPathsOf(tool)) writes.push([normalizeAbsPath(path, cwd, home), tool.completedAt ?? tool.createdAt ?? 0]);
    }
    entryCache.set(message, { key, writes });
    return writes;
}

/**
 * Completion time of the latest agent write to `targetPath`, 0 when none.
 * Only the TIME is compared by the viewer (against when it read the file):
 * a count would move when older history pages load (review 中2).
 */
export function lastAgentWriteAt(messages: readonly Message[], targetPath: string, cwd: string | null | undefined, home?: string | null): number {
    const target = normalizeAbsPath(targetPath, cwd, home);
    let last = 0;
    for (const message of messages) {
        if (message.kind !== 'tool-call') continue;
        for (const [path, at] of writesOf(message, cwd, home)) if (path === target && at > last) last = at;
    }
    return last;
}

/** A write is news only if it completed after the content on screen was read. */
export function isNewWrite(lastWriteAt: number, readAt: number): boolean {
    return lastWriteAt > readAt;
}

/** What to do when the signature moved: refresh quietly only if the user is not mid-reading. */
export type ChangeAction = 'silent' | 'banner' | 'reload';
export function changeAction(input: {
    phase: string;
    kind: string;
    visible: boolean;
    hasSelection: boolean;
    msSinceInteraction: number;
}): ChangeAction {
    if (input.phase === 'loading') return 'reload';
    if (input.phase !== 'text' || input.kind === 'html') return 'banner';
    if (!input.visible || input.hasSelection || input.msSinceInteraction < QUIET_MS) return 'banner';
    return 'silent';
}
/** No scroll / pointer-down inside the viewer for this long = not actively reading. */
export const QUIET_MS = 1500;
