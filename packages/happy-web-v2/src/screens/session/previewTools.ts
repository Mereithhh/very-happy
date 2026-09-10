import type { Message, ToolCall } from '@/sync/typesMessage';
import { normalizePreviewPath } from '@/sync/filePreview';

export function previewToolPath(tool: ToolCall): string | null {
    if (tool.name === 'mcp__happy__open_preview' || tool.name === 'open_preview') return normalizePreviewPath(tool.input?.path);
    if (tool.name === 'McpTool' && tool.input?.server === 'happy' && tool.input?.tool === 'open_preview') return normalizePreviewPath(tool.input.arguments?.path);
    return null;
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
