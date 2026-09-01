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
    metadata: Pick<Metadata, 'flavor' | 'path' | 'claudeSessionId' | 'codexThreadId'>,
    fs: ResumePrecheckFs,
): { ok: true } | { ok: false; reason: ResumePrecheckReason; detail: string } {
    const flavor = metadata.flavor ?? 'claude';
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

/** `--model` rides argv verbatim (no shell), so the only risk is a value that
 *  parses as another flag; keep it to a model-name charset. */
export function sanitizeResumeModel(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(value) ? value : null;
}
