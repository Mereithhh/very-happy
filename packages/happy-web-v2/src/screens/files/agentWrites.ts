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

/** Resolve against cwd, then fold `.`/`..`/`//` so tool paths and viewer paths compare equal. */
export function normalizeAbsPath(path: string, cwd: string | null | undefined): string {
    const resolved = resolveAgainstCwd(path.replace(/\\/g, '/'), cwd);
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

/**
 * `count:lastCompletedAt` of completed writes to `targetPath` (any order of
 * messages). Equal signatures = nothing new was written.
 */
export function agentWriteSignature(messages: readonly Message[], targetPath: string, cwd: string | null | undefined): string {
    const target = normalizeAbsPath(targetPath, cwd);
    let count = 0;
    let last = 0;
    for (const tool of walkToolCalls(messages)) {
        for (const path of writtenPathsOf(tool)) {
            if (normalizeAbsPath(path, cwd) !== target) continue;
            count++;
            last = Math.max(last, tool.completedAt ?? tool.createdAt ?? 0);
        }
    }
    return `${count}:${last}`;
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
