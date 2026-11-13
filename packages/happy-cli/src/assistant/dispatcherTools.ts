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
    const merged = new Set<string>([...(current ?? []), ...ASSISTANT_DISALLOWED_TOOLS.filter(t => !builtinsAllowed.has(t)), ...extraDenied]);
    return [...merged];
}

/**
 * B-916c gate 1: user denylist entries the SDK can drop natively (plain names,
 * whole-server specs). Set once per process by the main agent start-up; the
 * wildcard patterns are enforced by the PreToolUse hook instead.
 */
let extraDenied: readonly string[] = [];
export function setAssistantExtraDenied(names: readonly string[]): void {
    extraDenied = [...new Set(names)];
}

/**
 * B-922 (spec §4.4): built-ins the main agent's safety setting turned on —
 * `bash` → Bash, `fileEdits` → Edit / Write / MultiEdit / NotebookEdit. Off by
 * default in every preset. Set once per process by the main agent start-up
 * (only the main agent; other assistant sessions keep all five denied).
 */
const FILE_EDIT_TOOLS: readonly string[] = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];
export function assistantBuiltinsAllowedBy(policy: { bash: boolean; fileEdits: boolean }): string[] {
    return [...(policy.bash ? ['Bash'] : []), ...(policy.fileEdits ? FILE_EDIT_TOOLS : [])];
}
let builtinsAllowed: ReadonlySet<string> = new Set();
export function setAssistantBuiltinsAllowed(names: readonly string[]): void {
    builtinsAllowed = new Set(names.filter(n => (ASSISTANT_DISALLOWED_TOOLS as readonly string[]).includes(n)));
}
