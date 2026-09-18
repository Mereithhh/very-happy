import { decodeBase64 } from '@/encryption/base64';
import type { Message } from './typesMessage';
import { normalizePreviewPath } from './filePreview';

export type ToolHistoryScope = { sessionId: string } | { machineId: string; terminalId: string };
export type ToolHistoryEntry = {
    id: string;
    kind: 'clipboard' | 'preview';
    createdAt: number;
    text: string | null;
    truncated?: boolean;
    mode?: 'file' | 'diff';
    /** Only transcript fallbacks have a known tool execution state. */
    state?: 'running' | 'completed' | 'error';
};
export function toolHistoryKey(scope: ToolHistoryScope): string {
    return 'sessionId' in scope
        ? `tool-history.v1/session/${encodeURIComponent(scope.sessionId)}`
        : `tool-history.v1/terminal/${encodeURIComponent(scope.machineId)}/${encodeURIComponent(scope.terminalId)}`;
}

/** The envelope is account KV; each payload retains its source's encryption. */
export async function decodeToolHistory(value: string | null, decrypt: (payload: string) => Promise<unknown>): Promise<ToolHistoryEntry[]> {
    if (value === null) return [];
    if (value.length > 350_000) throw new Error('Invalid tool history');
    const parsed = JSON.parse(new TextDecoder().decode(decodeBase64(value)));
    if (parsed?.version !== 1 || !Array.isArray(parsed.entries)) throw new Error('Unsupported tool history');
    return Promise.all(parsed.entries.slice(0, 50).filter((v: any) => v && typeof v.id === 'string'
        && (v.kind === 'clipboard' || v.kind === 'preview') && Number.isFinite(v.createdAt)
        && v.createdAt >= 0 && v.createdAt <= 8.64e15
        && typeof v.payload === 'string' && v.payload.length <= 48 * 1024 && typeof v.enc === 'boolean')
        .map(async (v: any): Promise<ToolHistoryEntry> => {
            let text: unknown = null;
            try { text = v.payload === '' && v.truncated ? null : v.enc ? await decrypt(v.payload) : v.payload; } catch { /* A broken entry must not hide the others. */ }
            return { id: v.id, kind: v.kind, createdAt: v.createdAt,
                text: v.kind === 'preview' ? normalizePreviewPath(text) : typeof text === 'string' ? text : null,
                truncated: v.truncated === true, mode: v.mode === 'diff' ? 'diff' : 'file' };
        }));
}

/** Backfill older chat calls, including the pi ACP rawInput envelope. */
export function transcriptClipboardHistory(messages: Message[]): ToolHistoryEntry[] {
    const entries: ToolHistoryEntry[] = [];
    function visit(items: Message[]) {
        for (const message of items) {
            if (message.kind !== 'tool-call') continue;
            const { tool } = message;
            const input = tool.name === 'McpTool' && tool.input?.server === 'happy' && tool.input?.tool === 'copy_to_clipboard'
                ? tool.input.arguments
                : tool.input?.piTool === 'copy_to_clipboard' ? tool.input.rawInput
                : ['copy_to_clipboard', 'mcp__happy__copy_to_clipboard', 'mcp__very-happy-clipboard__copy_to_clipboard'].includes(tool.name) ? tool.input : null;
            if (typeof input?.text === 'string') entries.push({ id: `transcript:${message.id}`, kind: 'clipboard',
                createdAt: tool.createdAt ?? message.createdAt, text: input.text, state: tool.state });
            visit(message.children);
        }
    }
    visit(messages);
    return entries.sort((a, b) => b.createdAt - a.createdAt).slice(0, 50);
}

/** Match at most one transcript call to each received push; repeated calls remain distinct. */
export function mergeToolHistory(stored: ToolHistoryEntry[], transcript: ToolHistoryEntry[]): ToolHistoryEntry[] {
    const available = new Set(stored.map(e => e.id));
    const replacements = new Map<string, ToolHistoryEntry>();
    const older = transcript.filter(entry => {
        const match = entry.state === 'error' ? undefined : stored.find(e => available.has(e.id) && e.kind === entry.kind
            && (e.text === entry.text || (e.truncated && !!e.text && entry.text?.startsWith(e.text)))
            && (entry.id.startsWith('legacy-preview:') || Math.abs(e.createdAt - entry.createdAt) <= 30_000));
        if (match) {
            available.delete(match.id);
            if (match.truncated && entry.text !== null) replacements.set(match.id, {...match, text:entry.text, truncated:false, state:entry.state});
            return false;
        }
        return true;
    });
    return [...stored.map(entry => replacements.get(entry.id) ?? entry), ...older].sort((a, b) => b.createdAt - a.createdAt).slice(0, 50);
}
