/**
 * B-614 — one identity vocabulary for every place agents meet: in-session
 * sub-agents, Codex child threads, Teams members and session peer messages.
 * Pure part (node-testable); the React atoms live in AgentChip.tsx.
 *
 * The glyph map is the sidebar's (Sidebar.tsx session rows): an agent must
 * look the same in the list, the transcript, the drawer and the team page.
 * Identity is never coloured — `--accent` means live and the tag palette means
 * metadata, so the name carries identity and the status slot carries state.
 */
export type AgentKind = 'claude' | 'codex' | 'pi' | 'terminal' | 'subagent' | 'team' | 'unknown';

/** Runner flavor / Teams `assistant` / peer `agent` field → kind. */
export function agentKindOf(flavor: string | null | undefined): AgentKind {
    switch (flavor?.trim()) {
        case 'claude': return 'claude';
        case 'codex': return 'codex';
        case 'pi': case 'pi-acp': case 'acp': return 'pi';
        case 'terminal-mirror': case 'terminal': return 'terminal';
        default: return 'unknown';
    }
}

/** Display name of a runner, shared with the session header (sessionAgentLabel). */
export function agentKindLabel(kind: AgentKind): string | null {
    switch (kind) {
        case 'claude': return 'Claude Code';
        case 'codex': return 'Codex';
        case 'pi': return 'Pi';
        case 'terminal': return 'Terminal';
        default: return null;
    }
}

export type AgentStatus = 'running' | 'completed' | 'failed' | 'stopped' | 'waiting';

/** A sub-agent type worth naming: the default `general-purpose` is noise on every row. */
export function notableSubagentType(type: string | null | undefined): string | null {
    const value = type?.trim();
    if (!value || value === 'general-purpose' || value === 'background-command') return null;
    return value;
}

/** Codex thread ids are long; rows show a short, still-unique-looking tail. */
export function shortThreadId(id: string): string {
    const parts = id.split(/[-_]/).filter(Boolean);
    const tail = parts.length > 1 ? parts.slice(-2).join('-') : id;
    return tail.length > 18 ? `…${tail.slice(-16)}` : tail;
}

/** Codex `CodexCollaboration` call → the child thread ids it reaches (empty = not a pointer). */
export function codexChildThreadIds(tool: { name: string; input?: unknown }): string[] {
    if (tool.name !== 'CodexCollaboration') return [];
    const ids = (tool.input as { receiverThreadIds?: unknown } | null | undefined)?.receiverThreadIds;
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string' && id.length > 0) : [];
}

/** `Codex · spawn` — the label the CLI already writes as the call's title. */
export function codexChildTitle(tool: { input?: unknown }): string {
    const op = (tool.input as { operation?: unknown } | null | undefined)?.operation;
    return typeof op === 'string' && op ? `Codex · ${op}` : 'Codex';
}
