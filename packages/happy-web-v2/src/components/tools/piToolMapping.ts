/**
 * pi tool → known (Claude-shaped) tool mapping (B-353, spec §B).
 *
 * A pi-aware happy-cli sends ACP tool calls as `toolName = kind` (`execute`/`read`/`edit`/`other`)
 * plus optional args `piTool`, `acpTitle`, `acpKind`, `rawInput`, `command`. When `piTool` names one
 * of pi's built-in file/shell tools whose args fit the Claude input shape, the call is rewritten so
 * the existing `Bash/Read/Edit/Write/Grep/Glob/LS` renderers apply. Anything else (no `piTool`,
 * unknown tool, shape mismatch) is returned untouched → today's behaviour.
 *
 * Pure: never throws, never mutates the input tool.
 */
import type { ToolCall } from '@/sync/typesMessage';

export type PiToolArgs = {
    piTool?: unknown;
    rawInput?: unknown;
    command?: unknown;
};

export type MappedKnownTool = { name: string; input: Record<string, unknown> };

/** Bridge-proxied very-happy tools that a pi session may call by name (rendered with their own cards). */
export const PI_BRIDGE_TOOLS = ['session_spawn', 'session_send', 'session_read', 'sessions_list', 'session_kill', 'session_archive', 'report_progress', 'change_title'] as const;
export type PiBridgeTool = typeof PI_BRIDGE_TOOLS[number];

export function isPiBridgeTool(name: unknown): name is PiBridgeTool {
    return typeof name === 'string' && (PI_BRIDGE_TOOLS as readonly string[]).includes(name);
}

function str(v: unknown): string | undefined {
    return typeof v === 'string' ? v : undefined;
}
function num(v: unknown): number | undefined {
    return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
function obj(v: unknown): Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
function compact(o: Record<string, unknown | undefined>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
    return out;
}

/** Map pi tool identity + args to a known tool name and Claude-shaped input; null when it does not fit. */
export function mapPiToolToKnown(args: PiToolArgs | null | undefined): MappedKnownTool | null {
    const piTool = str(args?.piTool);
    if (!piTool) return null;
    const raw = obj(args?.rawInput);
    switch (piTool) {
        case 'bash': {
            const command = str(args?.command) ?? str(raw.command);
            if (!command) return null;
            return { name: 'Bash', input: compact({ command, timeout: num(raw.timeout) }) };
        }
        case 'read': {
            const path = str(raw.path);
            if (!path) return null;
            return { name: 'Read', input: compact({ file_path: path, limit: num(raw.limit), offset: num(raw.offset) }) };
        }
        case 'edit': {
            const path = str(raw.path);
            const oldText = str(raw.oldText);
            const newText = str(raw.newText);
            if (!path || oldText === undefined || newText === undefined) return null;
            return { name: 'Edit', input: { file_path: path, old_string: oldText, new_string: newText } };
        }
        case 'write': {
            const path = str(raw.path);
            const content = str(raw.content);
            if (!path || content === undefined) return null;
            return { name: 'Write', input: { file_path: path, content } };
        }
        case 'grep': {
            const pattern = str(raw.pattern);
            if (!pattern) return null;
            return { name: 'Grep', input: compact({ pattern, path: str(raw.path), glob: str(raw.glob) }) };
        }
        case 'find': {
            const pattern = str(raw.pattern);
            if (!pattern) return null;
            return { name: 'Glob', input: compact({ pattern, path: str(raw.path) }) };
        }
        case 'ls': {
            const path = str(raw.path);
            if (!path) return null;
            return { name: 'LS', input: { path } };
        }
        default:
            return null;
    }
}

/**
 * Rewrite a pi tool call into its known-tool equivalent for rendering. Bridge tools are renamed to
 * their `piTool` (so `knownTools`/`ToolView` can key on `session_spawn` etc.); everything else that
 * does not map is returned as-is (same object identity → no re-render churn).
 */
export function normalizePiToolCall(tool: ToolCall): ToolCall {
    const input = tool.input;
    if (typeof input !== 'object' || input === null || typeof input.piTool !== 'string') return tool;
    const mapped = mapPiToolToKnown(input);
    if (mapped) return { ...tool, name: mapped.name, input: mapped.input };
    if (isPiBridgeTool(input.piTool)) return { ...tool, name: input.piTool, input: obj(input.rawInput) };
    return tool;
}
