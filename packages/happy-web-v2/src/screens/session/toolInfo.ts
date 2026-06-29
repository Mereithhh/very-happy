import type { ToolCall } from '@/sync/typesMessage';

/** A short, human-friendly title for a tool call (no RN deps). */
export function toolTitle(tool: ToolCall): string {
    if (tool.description) return tool.description;
    const input = tool.input ?? {};
    switch (tool.name) {
        case 'Bash':
            return typeof input.command === 'string' ? input.command : 'Terminal';
        case 'Read':
        case 'Write':
        case 'Edit':
        case 'MultiEdit':
            return typeof input.file_path === 'string' ? `${tool.name} ${basename(input.file_path)}` : tool.name;
        case 'Glob':
            return typeof input.pattern === 'string' ? `Glob ${input.pattern}` : 'Glob';
        case 'Grep':
            return typeof input.pattern === 'string' ? `Grep ${input.pattern}` : 'Grep';
        case 'WebFetch':
            return typeof input.url === 'string' ? `Fetch ${input.url}` : 'WebFetch';
        case 'Task':
        case 'Agent':
            return typeof input.description === 'string' ? input.description : 'Task';
        default:
            return tool.name;
    }
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

/** Best-effort string rendering of a tool result for the generic output view. */
export function resultToText(result: unknown): string {
    if (result == null) return '';
    if (typeof result === 'string') return result;
    if (typeof result === 'object') {
        const r = result as Record<string, unknown>;
        if (typeof r.stdout === 'string' || typeof r.stderr === 'string') {
            return [r.stdout, r.stderr].filter(Boolean).join('\n');
        }
        try {
            return JSON.stringify(result, null, 2);
        } catch {
            return String(result);
        }
    }
    return String(result);
}
