import { resolveAgainstCwd } from './toolFilePath';
import type { ToolHistoryEntry } from '@/sync/toolHistory';
import type { Message, ToolCall } from '@/sync/typesMessage';
import { normalizePreviewPath } from '@/sync/filePreview';

export interface PreviewToolCall {
    /** As the agent wrote it (absolute, `~/…` or cwd-relative). */
    path: string;
    /** B-562: `open_preview(download: true)` — the agent is delivering the file. */
    download: boolean;
}

/**
 * An `open_preview` call in ANY runner's name shape (B-499 identity: Claude
 * `mcp__happy__…`, terminal `mcp__very-happy__…`, Gemini `happy__…`, Codex
 * `McpTool`, pi `piTool`, bare). Pure web: works for transcripts written by
 * CLIs that predate the `download` flag.
 */
export function previewToolCall(tool: ToolCall): PreviewToolCall | null {
    const input = previewToolInput(tool);
    const path = input ? normalizePreviewPath(input.path) : null;
    return path ? { path, download: input!.download === true } : null;
}

/** Same shape rules as `resolveBuiltinTool` (components/tools/builtinTools.ts),
 *  kept local so this module stays free of the i18n/text runtime. */
function previewToolInput(tool: ToolCall): Record<string, any> | null {
    const input = tool.input && typeof tool.input === 'object' ? tool.input as Record<string, any> : {};
    const own = (server: unknown) => typeof server === 'string' && /happy/i.test(server);
    if (input.piTool === 'open_preview') return objectOr(input.rawInput);
    if (tool.name === 'McpTool') return input.tool === 'open_preview' && own(input.server) ? objectOr(input.arguments) : null;
    if (typeof tool.name !== 'string') return null;
    if (tool.name === 'open_preview') return input;
    const bare = tool.name.startsWith('mcp__') ? tool.name.slice('mcp__'.length) : tool.name;
    const cut = bare.lastIndexOf('__');
    return cut > 0 && bare.slice(cut + 2) === 'open_preview' && own(bare.slice(0, cut)) ? input : null;
}

function objectOr(value: unknown): Record<string, any> {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
}

export function previewToolPath(tool: ToolCall): string | null {
    return previewToolCall(tool)?.path ?? null;
}

export function sessionPreviewPaths(messages: Message[]): string[] {
    const paths = new Set<string>();
    function visit(items: Message[]) {
        for (const message of items) {
            if (message.kind !== 'tool-call') continue;
            const path = previewToolPath(message.tool);
            if (path) paths.add(path);
            visit(message.children);
        }
    }
    visit(messages);
    return [...paths];
}

export function legacyPreviewHistory(paths: string[], cwd?: string): ToolHistoryEntry[] {
    return [...new Set(paths.map(path => resolveAgainstCwd(path, cwd)))].map(path => ({
        id:`legacy-preview:${path}`,kind:'preview',createdAt:0,text:path,
    }));
}
