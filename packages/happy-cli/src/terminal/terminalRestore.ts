/**
 * restore-terminal planning (B-265) — pure. A closed terminal comes back with
 * its ORIGINAL id, cwd, title (+ manual flag) and tags; when the record knows
 * the claude conversation that ran inside AND its JSONL is still on disk, the
 * fresh shell gets `claude --resume <id>` injected. The daemon supplies the
 * filesystem / tmux facts; nothing here touches either.
 */
import type { ClosedTerminalRecord } from './closedTerminals';
import { isClaudeSessionId } from './liveTerminals';
import { attachStartupCommand } from './userTmuxSessions';

export const TERMINAL_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

export interface TerminalRestoreFacts {
    tmuxAlive: boolean;
    cwdExists: (cwd: string) => boolean;
    conversationExists: (cwd: string, claudeSessionId: string) => boolean;
    /** B-273: the machine's CURRENT user tmux sessions (`{id:'$N', name}`),
     *  only needed for records with `attachTmux`. Absent → treated as none. */
    userSessions?: ReadonlyArray<{ id: string; name: string }>;
    /** B-273: `VH_TMUX_SOCKET` when the daemon runs on a private socket. */
    attachSocket?: string;
    /** B-273: where an attach terminal starts when its recorded cwd is gone
     *  (the directory is irrelevant inside the attached session). */
    homeDir?: string;
}

export type TerminalRestorePlan =
    | { kind: 'already-live' }
    | { kind: 'error'; reason: 'missing-cwd' | 'tmux-session-gone' }
    | { kind: 'create'; terminalId: string; cwd: string; title?: string; manual: boolean; tags?: string[]; command?: string; attachTmux?: string; cols?: number; rows?: number };

/** B-287: the recorded pane geometry, when the record has one. */
function recordGeometry(record: ClosedTerminalRecord): { cols: number; rows: number } | Record<string, never> {
    return record.cols !== undefined && record.rows !== undefined ? { cols: record.cols, rows: record.rows } : {};
}

export function planTerminalRestore(record: ClosedTerminalRecord, facts: TerminalRestoreFacts): TerminalRestorePlan {
    if (facts.tmuxAlive) return { kind: 'already-live' };
    if (record.attachTmux) {
        // B-273: an attach terminal comes back ATTACHED or not at all — an
        // empty shell titled after the session would be a lie. Resolve the
        // name against the live list; it must be unique (ids are not stable
        // across tmux server restarts, so the name is what was persisted).
        const matches = (facts.userSessions ?? []).filter((s) => s.name === record.attachTmux);
        if (matches.length !== 1) return { kind: 'error', reason: 'tmux-session-gone' };
        const cwd = record.cwd && facts.cwdExists(record.cwd) ? record.cwd : facts.homeDir;
        if (!cwd) return { kind: 'error', reason: 'missing-cwd' };
        return {
            kind: 'create',
            terminalId: record.id,
            cwd,
            title: record.title ?? record.attachTmux,
            manual: true,
            tags: record.tags,
            command: attachStartupCommand(matches[0].id, facts.attachSocket),
            attachTmux: record.attachTmux,
            ...recordGeometry(record),
        };
    }
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
        ...recordGeometry(record),
    };
}
