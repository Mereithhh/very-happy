/**
 * resume-happy-session prechecks (B-265) — pure, so every reason the web can
 * show ("no conversation to resume", "directory gone", …) is unit-tested.
 * The daemon feeds in the filesystem facts; nothing here touches disk.
 */
import type { Metadata } from '@/api/types';
import { isClaudeSessionId } from '@/terminal/liveTerminals';

export type ResumePrecheckReason =
    | 'unsupported-flavor'
    | 'no-backend-id'
    | 'missing-cwd'
    | 'conversation-missing';

export interface ResumePrecheckFs {
    cwdExists: (path: string) => boolean;
    /** claude only: `<projectPath(cwd)>/<claudeSessionId>.jsonl` on disk. */
    conversationExists: (cwd: string, claudeSessionId: string) => boolean;
}

export function resumePrecheck(
    metadata: Pick<Metadata, 'flavor' | 'path' | 'claudeSessionId' | 'codexThreadId' | 'piSessionId'>,
    fs: ResumePrecheckFs,
): { ok: true } | { ok: false; reason: ResumePrecheckReason; detail: string } {
    const flavor = metadata.flavor ?? 'claude';
    // B-633: a pi session (ACP flavor) that recorded its pi session id can be
    // reopened (`pi --resume` → pi-acp `session/load`). The pi session file is
    // pi-acp's to find; a vanished one degrades to a fresh conversation inside
    // the wrapper (with a one-line notice), not a precheck failure.
    if (flavor === 'acp' && metadata.piSessionId) {
        if (!metadata.path || !fs.cwdExists(metadata.path)) {
            return { ok: false, reason: 'missing-cwd', detail: `working directory ${metadata.path ?? '(none)'} does not exist` };
        }
        return { ok: true };
    }
    if (flavor !== 'claude' && flavor !== 'codex') {
        return { ok: false, reason: 'unsupported-flavor', detail: `flavor "${flavor}" cannot be resumed` };
    }
    if (!metadata.path || !fs.cwdExists(metadata.path)) {
        return { ok: false, reason: 'missing-cwd', detail: `working directory ${metadata.path ?? '(none)'} does not exist` };
    }
    if (flavor === 'codex') {
        if (!metadata.codexThreadId) return { ok: false, reason: 'no-backend-id', detail: 'session has no Codex thread id' };
        return { ok: true };
    }
    if (!isClaudeSessionId(metadata.claudeSessionId)) {
        return { ok: false, reason: 'no-backend-id', detail: 'session has no Claude session id' };
    }
    if (!fs.conversationExists(metadata.path, metadata.claudeSessionId)) {
        return { ok: false, reason: 'conversation-missing', detail: `conversation ${metadata.claudeSessionId} is not on disk` };
    }
    return { ok: true };
}

/**
 * Which precheck failures a resume turns into a FRESH agent conversation in the
 * same directory (same happy session row, no `--resume`) instead of an error.
 *   - `conversation-missing`: the transcript is gone, the history stays on the
 *     server.
 *   - `no-backend-id` (B-680): the session never ran a turn, so there is no
 *     agent conversation to reopen — and nothing to lose by starting one. Used
 *     to be fatal, which left a stopped empty session with no way back.
 * A bad cwd or an unsupported flavor stays fatal.
 */
export function resumeStartsFreshConversation(reason: ResumePrecheckReason): boolean {
    return reason === 'conversation-missing' || reason === 'no-backend-id';
}

/** `--model` rides argv verbatim (no shell), so the only risk is a value that
 *  parses as another flag; keep it to a model-name charset. The only bracket
 *  form allowed is Claude Code's own 1M-context marker (`opus[1m]`,
 *  `fable[1m]`), which the web model picker offers since Fable 5.1. */
export function sanitizeResumeModel(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}(\[1m\])?$/i.test(value) ? value : null;
}
