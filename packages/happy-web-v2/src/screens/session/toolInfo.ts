import type { ToolCall } from '@/sync/typesMessage';

/** A short, human-friendly subtitle/detail for a tool call (path, command, etc). */
export function toolDetail(tool: ToolCall): string | null {
    const input = tool.input ?? {};
    switch (tool.name) {
        case 'Bash':
            return typeof input.command === 'string' ? input.command : null;
        case 'Read':
        case 'Write':
        case 'Edit':
        case 'MultiEdit':
        case 'NotebookEdit':
            return typeof input.file_path === 'string' ? basename(input.file_path) : null;
        case 'Glob':
            return typeof input.pattern === 'string' ? input.pattern : null;
        case 'Grep':
            return typeof input.pattern === 'string' ? input.pattern : null;
        case 'LS':
            return typeof input.path === 'string' ? input.path : null;
        case 'WebFetch':
            return typeof input.url === 'string' ? input.url : null;
        case 'WebSearch':
            return typeof input.query === 'string' ? input.query : null;
        case 'Task':
        case 'Agent':
            return typeof input.description === 'string'
                ? input.description
                : typeof input.subagent_type === 'string'
                    ? input.subagent_type
                    : null;
        default: {
            // Common MCP detail fields.
            for (const key of ['query', 'url', 'path', 'file_path', 'pattern', 'prompt']) {
                if (typeof (input as any)[key] === 'string') return (input as any)[key];
            }
            return tool.description?.trim() || null;
        }
    }
}

/** The short label shown in the tool-call header (left of the detail). */
export function toolLabel(tool: ToolCall): string {
    switch (tool.name) {
        case 'Bash':
            return 'Terminal';
        case 'Task':
        case 'Agent':
            return 'Task';
        default:
            return prettyToolName(tool.name);
    }
}

/** Full single-line title (label + detail) — used where only one string fits. */
export function toolTitle(tool: ToolCall): string {
    const label = toolLabel(tool);
    const detail = toolDetail(tool);
    if (detail && detail !== label) return `${label} · ${detail}`;
    return label;
}

function basename(p: string): string {
    const parts = p.split('/');
    return parts[parts.length - 1] || p;
}

/** Extract a Bash command + stdout/stderr for CommandView, if this is a Bash tool. */
export function asCommand(tool: ToolCall): { command: string; stdout?: string; stderr?: string; error?: string } | null {
    if (tool.name !== 'Bash') return null;
    const command = typeof tool.input?.command === 'string' ? tool.input.command : '';
    if (!command) return null;
    const r = tool.result;
    let stdout: string | undefined;
    let stderr: string | undefined;
    if (r && typeof r === 'object') {
        if (typeof r.stdout === 'string') stdout = r.stdout;
        if (typeof r.stderr === 'string') stderr = r.stderr;
    } else if (typeof r === 'string') {
        stdout = r;
    }
    const error = tool.state === 'error' ? extractError(tool) : undefined;
    return { command, stdout, stderr, error };
}

export function extractError(tool: ToolCall): string | undefined {
    const r = tool.result;
    if (typeof r === 'string') return r;
    if (r && typeof r === 'object') {
        if (typeof r.error === 'string') return r.error;
        if (typeof r.message === 'string') return r.message;
    }
    return undefined;
}

/**
 * Best-effort string rendering of a tool result for the generic output view.
 * Handles the shapes tool results actually arrive in:
 *  - plain string
 *  - `{ stdout, stderr }` (Bash and friends)
 *  - MCP-style content-block arrays: `[{ type: 'text', text }]`
 *  - `{ content: [...] | string }` envelopes
 * Falls back to pretty JSON only when nothing textual is found.
 */
export function resultToText(result: unknown): string {
    if (result == null) return '';
    if (typeof result === 'string') return result;

    // Content-block array (MCP / Claude tool_result content)
    if (Array.isArray(result)) {
        const joined = result
            .map((b) => (b && typeof b === 'object' && typeof (b as any).text === 'string' ? (b as any).text : null))
            .filter((s): s is string => s != null)
            .join('\n');
        if (joined) return joined;
        try {
            return JSON.stringify(result, null, 2);
        } catch {
            return String(result);
        }
    }

    if (typeof result === 'object') {
        const r = result as Record<string, unknown>;
        if (typeof r.stdout === 'string' || typeof r.stderr === 'string') {
            return [r.stdout, r.stderr].filter(Boolean).join('\n');
        }
        // Nested content envelope
        if ('content' in r) {
            const inner = resultToText(r.content);
            if (inner) return inner;
        }
        if (typeof r.text === 'string') return r.text;
        if (typeof r.output === 'string') return r.output;
        if (typeof r.result === 'string') return r.result;
        try {
            return JSON.stringify(result, null, 2);
        } catch {
            return String(result);
        }
    }
    return String(result);
}

/** Strip an `mcp__server__tool` name into a readable `{ server, tool }`. */
export function parseMcpName(name: string): { server: string; tool: string } | null {
    if (!name.startsWith('mcp__')) return null;
    const rest = name.slice('mcp__'.length);
    const idx = rest.indexOf('__');
    if (idx <= 0 || idx + 2 >= rest.length) return null;
    return { server: rest.slice(0, idx), tool: rest.slice(idx + 2) };
}

/** Human-readable tool label: MCP → "server · tool", otherwise the raw name. */
export function prettyToolName(name: string): string {
    const mcp = parseMcpName(name);
    if (mcp) return `${mcp.server} · ${mcp.tool}`;
    return name;
}
