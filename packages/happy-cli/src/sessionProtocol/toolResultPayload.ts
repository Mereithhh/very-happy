/**
 * B-771: the output of an ordinary tool call, carried on the session protocol's
 * `tool-call-end.result` (same `{ text, truncated?, isError? }` shape the
 * foreground sub-agent report already uses, so Web needs no new field). Shared
 * by the Claude, Codex and ACP mappers.
 *
 * Pure, no I/O. Every result is persisted on the server and replayed to every
 * device, so the text is capped by UTF-8 size and cut on a code-point boundary
 * (never mid-surrogate: CJK and emoji stay whole). Images and other binary
 * blocks are summarized as `[image image/png, 12 KB]` — never their bytes.
 */

export const TOOL_RESULT_MAX_BYTES = 32 * 1024;

export type ToolResultPayload = { text: string; truncated?: boolean; isError?: boolean };

function formatSize(bytes: number): string {
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** Decoded size of a base64 payload, without decoding it. */
function base64Bytes(data: string): number {
    const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
    return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
}

function binaryBlockLabel(kind: string, source: unknown): string {
    const src = source && typeof source === 'object' ? source as { media_type?: unknown; data?: unknown } : {};
    const parts = [typeof src.media_type === 'string' ? src.media_type : null];
    if (typeof src.data === 'string') parts.push(formatSize(base64Bytes(src.data)));
    const detail = parts.filter(Boolean).join(', ');
    return detail ? `[${kind} ${detail}]` : `[${kind}]`;
}

/** Text of a tool_result `content` (string or content-block array). */
export function toolResultContentText(content: unknown): string {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    const parts: string[] = [];
    for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        const b = block as { type?: unknown; text?: unknown; source?: unknown; content?: unknown; mimeType?: unknown; data?: unknown };
        if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
        else if (b.type === 'image' || b.type === 'document' || b.type === 'audio') {
            // Claude nests bytes in `source`; MCP/ACP put `mimeType` + `data` on the block.
            parts.push(binaryBlockLabel(b.type, b.source ?? { media_type: b.mimeType, data: b.data }));
        }
        // ACP wraps a content block one level down: `{ type: 'content', content: {...} }`.
        else if (b.type === 'content') {
            const inner = toolResultContentText([b.content]);
            if (inner) parts.push(inner);
        }
        // ACP diff / terminal blocks are already shown from the call's own arguments.
        else if (b.type === 'diff' || b.type === 'terminal') continue;
        else if (typeof b.type === 'string') parts.push(`[${b.type}]`);
    }
    return parts.join('\n');
}

/** Longest prefix of `text` whose UTF-8 encoding fits `maxBytes`, cut between code points. */
export function capUtf8(text: string, maxBytes = TOOL_RESULT_MAX_BYTES): { text: string; truncated: boolean } {
    // Fast path: even at 3 bytes per UTF-16 unit (the worst case) it fits.
    if (text.length * 3 <= maxBytes) return { text, truncated: false };
    let bytes = 0;
    let end = 0;
    for (const ch of text) {
        const cp = ch.codePointAt(0)!;
        const size = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
        if (bytes + size > maxBytes) return { text: text.slice(0, end), truncated: true };
        bytes += size;
        end += ch.length;
    }
    return { text, truncated: false };
}

/**
 * The `tool-call-end.result` for a tool_result block, or undefined when there
 * is nothing to carry (empty output of a successful call).
 */
export function toolResultPayload(block: { content?: unknown; is_error?: unknown }, maxBytes = TOOL_RESULT_MAX_BYTES): ToolResultPayload | undefined {
    return textResultPayload(toolResultContentText(block.content), block.is_error === true, maxBytes);
}

/** Same as toolResultPayload for output that is already text (Codex aggregatedOutput, errors). */
export function textResultPayload(raw: string, isError: boolean, maxBytes = TOOL_RESULT_MAX_BYTES): ToolResultPayload | undefined {
    if (!raw && !isError) return undefined;
    const capped = capUtf8(raw, maxBytes);
    return {
        text: capped.text,
        ...(capped.truncated ? { truncated: true } : {}),
        ...(isError ? { isError: true } : {}),
    };
}
