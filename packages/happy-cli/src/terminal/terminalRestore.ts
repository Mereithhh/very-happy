/**
 * restore-terminal planning (B-265) — pure. A closed terminal comes back with
 * its ORIGINAL id, cwd, title (+ manual flag) and tags; when the record knows
 * the claude conversation that ran inside AND its JSONL is still on disk, the
 * fresh shell gets `claude --resume <id>` injected. The daemon supplies the
 * filesystem / tmux facts; nothing here touches either.
 */
import type { ClosedTerminalRecord } from './closedTerminals';
import { isClaudeSessionId } from './liveTerminals';

export const TERMINAL_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

export interface TerminalRestoreFacts {
    tmuxAlive: boolean;
    cwdExists: (cwd: string) => boolean;
    conversationExists: (cwd: string, claudeSessionId: string) => boolean;
}

export type TerminalRestorePlan =
    | { kind: 'already-live' }
    | { kind: 'error'; reason: 'missing-cwd' }
    | { kind: 'create'; terminalId: string; cwd: string; title?: string; manual: boolean; tags?: string[]; command?: string };

export function planTerminalRestore(record: ClosedTerminalRecord, facts: TerminalRestoreFacts): TerminalRestorePlan {
    if (facts.tmuxAlive) return { kind: 'already-live' };
    if (!record.cwd || !facts.cwdExists(record.cwd)) return { kind: 'error', reason: 'missing-cwd' };
    const resumable = isClaudeSessionId(record.claudeSessionId) && facts.conversationExists(record.cwd, record.claudeSessionId);
    return {
        kind: 'create',
        terminalId: record.id,
        cwd: record.cwd,
        title: record.title,
        manual: record.manual === true,
        tags: record.tags,
        ...(resumable ? { command: `claude --resume ${record.claudeSessionId}` } : {}),
    };
}
