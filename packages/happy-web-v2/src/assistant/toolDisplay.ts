/**
 * toolDisplay — friendly presentation of the assistant's tool calls (B-092).
 *
 * Pure, unit-tested. The /assistant screen is a VOICE surface: raw tool names
 * (`mcp__happy__session_spawn`) read like stack traces there. This module maps
 * the assistant's usual tool face to friendly-name KEYS (the screen resolves
 * them through i18n) and extracts a short human argument summary from
 * `tool.input` — defensively, since input is untyped wire data.
 *
 * Anything outside the known face falls back to the normalized raw name
 * (mcp__server__tool → tool) with a best-effort generic summary.
 */

export type ToolFriendlyKey =
    | 'sessionsList'
    | 'sessionSpawn'
    | 'sessionSend'
    | 'sessionRead'
    | 'terminalsList'
    | 'terminalRead'
    | 'terminalSend'
    | 'memoryUpdate'
    | 'journalAppend'
    | 'lookup'
    | 'web';

/** Longest argument summary shown in the ticker / transcript rows. */
export const TOOL_SUMMARY_MAX_CHARS = 48;

/** How many leading chars of a session id stand in for a missing title. */
export const SESSION_ID_SUMMARY_CHARS = 8;

/** Strip an `mcp__server__tool` wire name down to the bare tool name. */
export function normalizeToolName(name: string): string {
    if (typeof name !== 'string') return '';
    if (!name.startsWith('mcp__')) return name;
    const rest = name.slice('mcp__'.length);
    const idx = rest.indexOf('__');
    if (idx <= 0 || idx + 2 >= rest.length) return name;
    return rest.slice(idx + 2);
}

const FRIENDLY_KEYS: Record<string, ToolFriendlyKey> = {
    sessions_list: 'sessionsList',
    session_spawn: 'sessionSpawn',
    session_send: 'sessionSend',
    session_read: 'sessionRead',
    terminals_list: 'terminalsList',
    terminal_read: 'terminalRead',
    terminal_send: 'terminalSend',
    memory_update: 'memoryUpdate',
    journal_append: 'journalAppend',
    Read: 'lookup',
    Grep: 'lookup',
    Glob: 'lookup',
    WebSearch: 'web',
    WebFetch: 'web',
};

/**
 * Friendly-name key for a tool, or null when the tool is outside the mapped
 * face (callers then show `normalizeToolName(name)` verbatim).
 */
export function toolFriendlyKey(name: string): ToolFriendlyKey | null {
    return FRIENDLY_KEYS[normalizeToolName(name)] ?? null;
}

function truncate(s: string, max = TOOL_SUMMARY_MAX_CHARS): string {
    const t = s.trim();
    return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function basename(p: string): string {
    const trimmed = p.replace(/\/+$/, '');
    const parts = trimmed.split('/');
    return parts[parts.length - 1] || trimmed || p;
}

function str(input: Record<string, unknown>, key: string): string | null {
    const v = input[key];
    return typeof v === 'string' && v.trim() ? v : null;
}

export interface ToolSummaryContext {
    /** map a session id to its display title (null/undefined = unknown) */
    resolveSessionTitle?: (sessionId: string) => string | null | undefined;
}

/**
 * Short human summary of the tool call's key argument, or null when there is
 * nothing worth showing (list tools, malformed input). Never throws.
 */
export function toolParamSummary(
    name: string,
    input: unknown,
    ctx?: ToolSummaryContext,
): string | null {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) return null;
    const args = input as Record<string, unknown>;
    try {
        switch (normalizeToolName(name)) {
            case 'sessions_list':
            case 'terminals_list':
                return null;
            case 'session_spawn': {
                const dir = str(args, 'directory');
                return dir ? truncate(basename(dir)) : null;
            }
            case 'session_send':
            case 'session_read':
            case 'session_kill':
            case 'session_archive': {
                const id = str(args, 'sessionId');
                if (!id) return null;
                const title = ctx?.resolveSessionTitle?.(id);
                return truncate(title && title.trim() ? title : id.slice(0, SESSION_ID_SUMMARY_CHARS));
            }
            case 'terminal_read':
            case 'terminal_send': {
                const id = str(args, 'terminalId');
                return id ? truncate(id, 16) : null;
            }
            case 'memory_update':
                return str(args, 'section') ? truncate(str(args, 'section')!) : null;
            case 'journal_append':
                return str(args, 'text') ? truncate(str(args, 'text')!) : null;
            case 'Read':
            case 'Write':
            case 'Edit': {
                const p = str(args, 'file_path');
                return p ? truncate(basename(p)) : null;
            }
            case 'Grep':
            case 'Glob':
                return str(args, 'pattern') ? truncate(str(args, 'pattern')!) : null;
            case 'WebSearch':
                return str(args, 'query') ? truncate(str(args, 'query')!) : null;
            case 'WebFetch': {
                const url = str(args, 'url');
                if (!url) return null;
                try {
                    return truncate(new URL(url).hostname);
                } catch {
                    return truncate(url);
                }
            }
            case 'Bash': {
                const cmd = str(args, 'command');
                return cmd ? truncate(cmd) : null;
            }
            default: {
                // generic MCP-ish fields, same priority as toolInfo.toolDetail
                for (const key of ['query', 'url', 'path', 'file_path', 'pattern', 'prompt', 'description']) {
                    const v = str(args, key);
                    if (v) return truncate(v);
                }
                return null;
            }
        }
    } catch {
        return null;
    }
}
