/**
 * B-628: naming the child threads `codex app-server` hosts beside the session's own.
 *
 * Codex announces a helper two ways (approach from Orca, src/main/codex/
 * codex-subagent-activity.ts + codex-collab-agent-tool-call.ts, read against app-server
 * 0.152–0.155): a `collabAgentToolCall` item — `spawnAgent` names the helper's thread id when the
 * call ends, beside the prompt it was given — or a `subAgentActivity` item — `agentThreadId` plus
 * a tree path such as `/root/list_directory`, whose leaf is the only label there is. Neither
 * carries a nickname, so the prompt head / path leaf is the name a reader gets for the card the
 * child's commands and messages are filed under.
 */

/** Row length for a helper named by its prompt: long enough to tell two helpers apart. */
export const CODEX_HELPER_LABEL_MAX_CHARS = 80;

export type CodexChildAnnouncement = { threadId: string; label: string | null };

/** The head of the prompt a helper was spawned with, on one line; null when there is none. */
export function codexHelperLabel(prompt: unknown): string | null {
    if (typeof prompt !== 'string') return null;
    const collapsed = prompt.replace(/\s+/g, ' ').trim();
    if (collapsed.length === 0) return null;
    if (collapsed.length <= CODEX_HELPER_LABEL_MAX_CHARS) return collapsed;
    const keep = CODEX_HELPER_LABEL_MAX_CHARS - 1;
    // Never end on half a surrogate pair: the label lands in a durable message.
    const last = collapsed.charCodeAt(keep - 1);
    const end = last >= 0xd800 && last <= 0xdbff ? keep - 1 : keep;
    return `${collapsed.slice(0, end)}…`;
}

/** `/root/list_directory` → `['root', 'list_directory']`; empty segments dropped. */
export function codexAgentPathSegments(agentPath: unknown): string[] {
    if (typeof agentPath !== 'string') return [];
    return agentPath.split('/').map((segment) => segment.trim()).filter((segment) => segment.length > 0);
}

/** The one path that names the parent turn itself, never a child. */
function isRootAgentPath(segments: string[]): boolean {
    return segments.length === 1 && segments[0] === 'root';
}

/**
 * The helpers an item announces, with the name it gives them. A `subAgentActivity` for the tree
 * root is the session's own turn, not a child; a path-less one cannot be placed and is kept as a
 * child without a name (dropping it would lose a real spawn). Any collab call counts, since a
 * helper whose spawn was compacted out of history is known only from the calls on it; only a
 * spawn's prompt names the helper — another call's prompt is a later message to it.
 */
export function codexChildAnnouncements(item: Record<string, unknown>): CodexChildAnnouncement[] {
    if (item.type === 'subAgentActivity') {
        const threadId = item.agentThreadId;
        if (typeof threadId !== 'string' || threadId.length === 0) return [];
        const segments = codexAgentPathSegments(item.agentPath);
        if (isRootAgentPath(segments)) return [];
        const leaf = segments.at(-1);
        return [{ threadId, label: leaf && leaf.length > 0 ? leaf : null }];
    }
    if (item.type === 'collabAgentToolCall') {
        const receivers = Array.isArray(item.receiverThreadIds)
            ? item.receiverThreadIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
            : [];
        const label = item.tool === 'spawnAgent' ? codexHelperLabel(item.prompt) : null;
        return [...new Set(receivers)].map((threadId) => ({ threadId, label }));
    }
    return [];
}
