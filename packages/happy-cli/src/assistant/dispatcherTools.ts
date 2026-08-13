/**
 * Dispatcher tool discipline for the assistant (meta) session — B-063.
 *
 * The assistant is a scheduler, not a worker: it spawns sessions to do the
 * hands-on work. Prompt-level "don't touch things yourself" is soft; this is
 * the hard boundary — the mutating built-in tools are denied at the SDK level
 * for assistant-variant sessions (OpenClaw discipline: no bash, no file
 * writes for the orchestrator).
 *
 * Kept: Read / Grep / Glob (memory + skills retrieval is grep-based by
 * design), web tools, Task (throwaway research subagents are fine), and the
 * assistant MCP surface (memory_update / journal_append are the sanctioned
 * write paths).
 */

export const ASSISTANT_DISALLOWED_TOOLS = [
    'Bash',
    'Edit',
    'Write',
    'MultiEdit',
    'NotebookEdit',
] as const;

/**
 * Merge the assistant denylist into the session's current disallowed tools.
 * No-op for normal sessions. The denylist is sticky for assistant sessions:
 * per-message overrides may add more denials but can never lift these.
 */
export function withAssistantDenylist(
    current: string[] | undefined,
    isAssistant: boolean,
): string[] | undefined {
    if (!isAssistant) return current;
    const merged = new Set<string>([...(current ?? []), ...ASSISTANT_DISALLOWED_TOOLS]);
    return [...merged];
}
