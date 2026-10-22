/**
 * Tool-call presentation across runners (B-754).
 *
 * The same operation reaches the web under different names and envelopes —
 * Claude's `Bash`, Codex's `CodexBash`, Gemini/ACP's `execute` + `acpTitle`;
 * Claude's `Edit`, Codex's `CodexPatch.changes`, ACP's `{type:'diff'}` result
 * blocks. This module reads those shapes (never rewrites them) into what a
 * card needs: a verb + key parameter for the row, and the command / file
 * edits / links / text a purpose-built body renders. Anything it does not
 * recognise falls back to the generic key/value table in `toolKeyValues.ts`.
 *
 * Pure: never throws, never mutates; tolerates the partial input a call has
 * while it streams.
 */
import type { ToolCall } from '@/sync/typesMessage';
import { t } from '@/text';
import { stringifyToolCommand } from '@/utils/toolCommand';
import { countLines, countReplacement, toolFileEdits, unifiedDiffRender, countUnifiedDiff, type FileEdit } from '@/screens/session/turnDiffs';
import { parseJsonText } from './toolKeyValues';

export type ToolVerb =
    | 'run' | 'read' | 'write' | 'edit' | 'search' | 'find' | 'list' | 'searchWeb' | 'fetch' | 'todo'
    | 'skill' | 'watch' | 'stopTask' | 'message' | 'wakeup' | 'schedule' | 'notify' | 'think' | 'delete'
    | 'move' | 'publish' | 'listAgents' | 'workflow';

export function toolVerbLabel(verb: ToolVerb): string {
    return t(`tools.verbs.${verb}` as 'tools.verbs.run');
}

// ── tolerant accessors ───────────────────────────────────────────────────────
function obj(v: unknown): Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
function str(v: unknown): string | null {
    return typeof v === 'string' && v.trim() !== '' ? v : null;
}
function num(v: unknown): number | null {
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
export function basename(p: string): string {
    const parts = p.replace(/\/+$/, '').split('/');
    return parts[parts.length - 1] || p;
}
function oneLine(text: string, max = 96): string {
    const line = text.replace(/\s+/g, ' ').trim();
    return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** `mcp__server__tool` / Gemini `server__tool` → parts; null for plain names. */
export function splitMcpName(name: string): { server: string; tool: string } | null {
    const bare = name.startsWith('mcp__') ? name.slice('mcp__'.length) : null;
    if (bare === null) return null;
    const idx = bare.indexOf('__');
    if (idx <= 0 || idx + 2 >= bare.length) return null;
    return { server: bare.slice(0, idx), tool: bare.slice(idx + 2) };
}

/** The tool's own name and arguments, unwrapped from Codex's `McpTool` envelope. */
export function mcpIdentity(tool: Pick<ToolCall, 'name' | 'input'>): { server: string; tool: string; args: Record<string, unknown> } | null {
    if (tool.name === 'McpTool') {
        const input = obj(tool.input);
        const server = str(input.server);
        const name = str(input.tool);
        return server && name ? { server, tool: name, args: obj(input.arguments) } : null;
    }
    const parts = typeof tool.name === 'string' ? splitMcpName(tool.name) : null;
    return parts ? { ...parts, args: obj(tool.input) } : null;
}

/** ACP-shaped call (pi without a mapped piTool, opencode, Gemini): kind + title. */
export function acpInfo(tool: Pick<ToolCall, 'name' | 'input'>): { kind: string; title: string | null; raw: Record<string, unknown> } | null {
    const input = obj(tool.input);
    const kind = str(input.acpKind);
    if (!kind && !('acpTitle' in input) && !('toolCall' in input)) return null;
    const title = str(input.acpTitle) ?? str(obj(input.toolCall).title);
    return { kind: kind ?? tool.name, title, raw: obj(input.rawInput) };
}

// ── result text ───────────────────────────────────────────────────────────────
/**
 * Text of an ACP content array (`[{type:'content',content:{type:'text',text}}]`)
 * or a `{text}` / `{content}` result; null when the result carries none.
 */
export function acpResultText(result: unknown): string | null {
    if (typeof result === 'string') return result;
    if (Array.isArray(result)) {
        const parts = result.map((b) => {
            const block = obj(b);
            if (typeof block.text === 'string') return block.text;
            const inner = obj(block.content);
            return typeof inner.text === 'string' ? inner.text : null;
        }).filter((s): s is string => s !== null);
        return parts.length ? parts.join('\n') : null;
    }
    const r = obj(result);
    if (typeof r.text === 'string') return r.text;
    if (typeof r.content === 'string') return r.content;
    if (Array.isArray(r.content)) return acpResultText(r.content);
    return null;
}

// ── commands ───────────────────────────────────────────────────────────────────
const COMMAND_TOOLS = new Set(['Bash', 'CodexBash', 'GeminiBash', 'shell', 'execute']);

export interface CommandInfo { command: string; cwd: string | null; description: string | null }

/** Gemini execute titles look like `rm f [cwd /x] (desc)`. */
function splitExecuteTitle(title: string): { command: string; cwd: string | null; description: string | null } {
    const m = /^(.*?)(?:\s+\[cwd ([^\]]+)\])?(?:\s+\(([^)]*)\))?\s*$/.exec(title.trim());
    if (!m) return { command: title.trim(), cwd: null, description: null };
    return { command: m[1].trim(), cwd: m[2]?.trim() ?? null, description: m[3]?.trim() || null };
}

export function commandInfo(tool: Pick<ToolCall, 'name' | 'input'>): CommandInfo | null {
    const input = obj(tool.input);
    const acp = acpInfo(tool);
    if (!COMMAND_TOOLS.has(tool.name) && acp?.kind !== 'execute') return null;
    const direct = stringifyToolCommand(input.command) ?? stringifyToolCommand(acp?.raw.command);
    const description = str(input.description) ?? str(acp?.raw.description);
    const cwd = str(input.cwd) ?? str(acp?.raw.cwd);
    if (direct) return { command: direct, cwd, description };
    if (acp?.title) {
        const parsed = splitExecuteTitle(acp.title);
        if (parsed.command) return { command: parsed.command, cwd: cwd ?? parsed.cwd, description: description ?? parsed.description };
    }
    return null;
}

// ── file reads ─────────────────────────────────────────────────────────────────
export interface ReadInfo { path: string | null; range: string | null }

export function readInfo(tool: Pick<ToolCall, 'name' | 'input'>): ReadInfo {
    const input = obj(tool.input);
    const loc = Array.isArray(input.locations) ? obj(input.locations[0]) : {};
    const path = str(input.file_path) ?? str(input.notebook_path) ?? str(input.path) ?? str(loc.path) ?? str(acpInfo(tool)?.title);
    const offset = num(input.offset) ?? num(loc.line);
    const limit = num(input.limit);
    const range = offset !== null && limit !== null ? `${offset}-${offset + limit - 1}` : offset !== null ? `${offset}` : null;
    return { path, range };
}

/**
 * Claude's Read result is `cat -n` text (`   10\tcode` or `10→code`); the card
 * draws its own gutter, so strip the prefix and keep the first number.
 */
export function stripReadLineNumbers(text: string): { code: string; startLine: number } {
    const lines = text.split('\n');
    const re = /^\s*(\d+)(?:\t|→)/;
    const numbered = lines.filter((l) => l !== '');
    if (numbered.length === 0 || !numbered.every((l) => re.test(l))) return { code: text, startLine: 1 };
    const first = Number(re.exec(numbered[0])![1]);
    return { code: lines.map((l) => l.replace(re, '')).join('\n'), startLine: first > 0 ? first : 1 };
}

// ── file edits ─────────────────────────────────────────────────────────────────
const PATCH_TOOLS = new Set(['CodexPatch', 'GeminiPatch', 'CodexDiff', 'GeminiDiff']);

function diffFilePath(diff: string): string | null {
    for (const line of diff.split('\n')) {
        const m = /^\+\+\+ (?:b\/)?(.+)$/.exec(line);
        if (m && m[1] !== '/dev/null') return m[1].trim();
    }
    return null;
}

function unifiedDiffEdit(path: string, diff: string): FileEdit {
    const render = unifiedDiffRender(diff);
    return { path, ...countUnifiedDiff(diff), renders: render ? [render] : [] };
}

/**
 * Files a patch-style call changes, with renderable old/new text: Codex
 * `CodexPatch` (live record or history array), `CodexDiff`/`GeminiDiff`
 * unified diffs, and ACP `{type:'diff', path, oldText, newText}` blocks (in the
 * call's `items` or its result). Unlike `toolFileEdits` this does not require
 * the call to have completed — a pending patch still shows what it proposes.
 */
export function patchEdits(tool: Pick<ToolCall, 'name' | 'input' | 'result' | 'state'>): FileEdit[] {
    const input = obj(tool.input);
    if (tool.name === 'CodexPatch' || tool.name === 'GeminiPatch') {
        const changes = Array.isArray(input.changes)
            ? Object.fromEntries(input.changes.map(obj).filter((c) => str(c.path)).map((c) => [c.path as string, c]))
            : input.changes;
        return toolFileEdits({ ...(tool as ToolCall), name: 'CodexPatch', state: 'completed', input: { ...input, changes } });
    }
    if (tool.name === 'CodexDiff' || tool.name === 'GeminiDiff') {
        const diff = str(input.unified_diff);
        if (!diff) return [];
        return [unifiedDiffEdit(str(input.filePath) ?? str(input.path) ?? diffFilePath(diff) ?? '', diff)];
    }
    const blocks = [...(Array.isArray(input.items) ? input.items : []), ...(Array.isArray(tool.result) ? tool.result : [])].map(obj);
    const edits: FileEdit[] = [];
    for (const b of blocks) {
        if (b.type !== 'diff' || typeof b.newText !== 'string') continue;
        const oldText = typeof b.oldText === 'string' ? b.oldText : '';
        const counts = oldText === '' ? { added: countLines(b.newText), removed: 0 } : countReplacement(oldText, b.newText);
        edits.push({ path: str(b.path) ?? '', added: counts?.added ?? null, removed: counts?.removed ?? null, renders: [{ oldText, newText: b.newText }] });
    }
    return edits;
}

export function isPatchTool(tool: Pick<ToolCall, 'name' | 'input'>): boolean {
    return PATCH_TOOLS.has(tool.name) || acpInfo(tool)?.kind === 'edit';
}

// ── links (web search results) ────────────────────────────────────────────────
export interface LinkItem { title: string; url: string; snippet: string | null }

function linkFrom(v: unknown): LinkItem | null {
    const o = obj(v);
    const url = str(o.url) ?? str(o.link) ?? str(o.href);
    if (!url || !/^https?:\/\//i.test(url)) return null;
    const title = str(o.title) ?? str(o.name) ?? url;
    const snippet = str(o.snippet) ?? str(o.content) ?? str(o.description) ?? null;
    return { title: oneLine(title, 140), url, snippet: snippet ? oneLine(snippet, 220) : null };
}

/**
 * Search results in the shapes tools return them: a JSON `{results:[…]}` /
 * bare array (Tavily, most MCP search tools), Claude WebSearch's
 * `Links: [{title,url}]` line, and Jina's YAML-ish `- title: / url: / snippet:`
 * list. `rest` is the text left over (WebSearch's summary), when any.
 */
export function parseSearchLinks(text: string): { links: LinkItem[]; rest: string | null } | null {
    const json = parseJsonText(text);
    if (json !== undefined) {
        const list = Array.isArray(json) ? json : Array.isArray(obj(json).results) ? (obj(json).results as unknown[]) : null;
        const links = (list ?? []).map(linkFrom).filter((l): l is LinkItem => l !== null);
        return links.length ? { links, rest: str(obj(json).answer) } : null;
    }
    const linksLine = /^Links: (\[.*\])\s*$/m.exec(text);
    if (linksLine) {
        try {
            const links = (JSON.parse(linksLine[1]) as unknown[]).map(linkFrom).filter((l): l is LinkItem => l !== null);
            if (links.length) {
                const rest = text
                    .replace(linksLine[0], '')
                    .replace(/^Web search results for query:.*$/m, '')
                    .replace(/^REMINDER:.*$/m, '')
                    .trim();
                return { links, rest: rest || null };
            }
        } catch { /* fall through */ }
    }
    if (/^\s*- title:/m.test(text) && /^\s+url:/m.test(text)) {
        const links: LinkItem[] = [];
        let cur: Record<string, string> | null = null;
        const flush = () => { const l = cur ? linkFrom(cur) : null; if (l) links.push(l); };
        for (const line of text.split('\n')) {
            const start = /^\s*- title:\s*(.*)$/.exec(line);
            if (start) { flush(); cur = { title: unquote(start[1]) }; continue; }
            const field = /^\s+(url|snippet):\s*(.*)$/.exec(line);
            if (cur && field) { cur[field[1]] = unquote(field[2]); continue; }
            const cont = /^\s{6,}(\S.*)$/.exec(line);
            if (cur && cont && cur.snippet !== undefined) cur.snippet += ` ${cont[1]}`;
        }
        flush();
        return links.length ? { links, rest: null } : null;
    }
    return null;
}

function unquote(s: string): string {
    const v = s.trim();
    return v.length >= 2 && v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1).replace(/\\"/g, '"') : v;
}

/** Jina-style `url: … / title: … / content: …` page text → its title and body. */
export function parseFetchedPage(text: string): { title: string | null; body: string } {
    const title = /^title:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? null;
    const content = /^content:\s*(?:>[-+0-9]*\s*)?\n?([\s\S]*)$/m.exec(text);
    if (title && content) return { title, body: content[1].replace(/^ {2}/gm, '').trim() };
    return { title: null, body: text };
}

// ── classification ────────────────────────────────────────────────────────────
export type ToolCard =
    | 'command' | 'read' | 'patch' | 'search' | 'webSearch' | 'fetch' | 'monitor' | 'think' | 'generic';

const WEB_SEARCH_RE = /(^|_)(search_web|web_search|websearch|tavily_search|brave_web_search|google_search)$/i;
const FETCH_RE = /(^|_)(read_url|fetch|fetch_url|web_fetch|tavily_extract|extract_pdf|scrape|firecrawl_scrape)$/i;

/** Which purpose-built body (if any) an otherwise-unclaimed call gets. */
export function toolCardKind(tool: Pick<ToolCall, 'name' | 'input'>): ToolCard {
    if (commandInfo(tool)) return 'command';
    if (isPatchTool(tool)) return 'patch';
    const acp = acpInfo(tool);
    if (acp) {
        if (acp.kind === 'read') return 'read';
        if (acp.kind === 'search') return 'search';
        if (acp.kind === 'fetch') return 'fetch';
        if (acp.kind === 'think') return 'think';
    }
    if (tool.name === 'CodexReasoning' || tool.name === 'GeminiReasoning') return 'think';
    if (tool.name === 'Monitor') return 'monitor';
    const mcp = mcpIdentity(tool);
    const bare = mcp?.tool ?? tool.name;
    const args = mcp?.args ?? obj(tool.input);
    if (WEB_SEARCH_RE.test(bare) && (str(args.query) || Array.isArray(args.query) || str(args.q))) return 'webSearch';
    if (FETCH_RE.test(bare) && (str(args.url) || Array.isArray(args.urls) || str(args.uri))) return 'fetch';
    return 'generic';
}

/** The query a web-search call asked, joined when several. */
export function searchQuery(tool: Pick<ToolCall, 'name' | 'input'>): string | null {
    const args = mcpIdentity(tool)?.args ?? obj(tool.input);
    const raw = obj(acpInfo(tool)?.raw);
    const q = args.query ?? args.q ?? args.pattern ?? raw.query ?? raw.pattern;
    if (Array.isArray(q)) return q.filter((x): x is string => typeof x === 'string').join(' | ') || null;
    return str(q) ?? str(acpInfo(tool)?.title);
}

/** The URL a fetch call targets. */
export function fetchUrl(tool: Pick<ToolCall, 'name' | 'input'>): string | null {
    const args = mcpIdentity(tool)?.args ?? obj(tool.input);
    const raw = acpInfo(tool)?.raw ?? {};
    const urls = Array.isArray(args.urls) ? args.urls.filter((u): u is string => typeof u === 'string') : [];
    const url = str(args.url) ?? str(args.uri) ?? urls[0] ?? str(raw.url);
    if (url) return url;
    const title = acpInfo(tool)?.title;
    return title ? /(https?:\/\/\S+)/.exec(title)?.[1] ?? null : null;
}

export function shortUrl(url: string): string {
    try {
        const u = new URL(url);
        const path = u.pathname === '/' ? '' : u.pathname;
        return oneLine(`${u.host}${path}`, 72);
    } catch {
        return oneLine(url, 72);
    }
}

// ── row header ────────────────────────────────────────────────────────────────
export interface ToolHeader {
    label: string;
    detail: string | null;
    /** The detail is a command / path / pattern (Mono) rather than prose. */
    mono: boolean;
}

/** First short, human-relevant argument of an unknown tool. */
function keyArg(args: Record<string, unknown>): string | null {
    for (const k of ['query', 'q', 'url', 'path', 'file_path', 'pattern', 'title', 'name', 'summary', 'search_query', 'prompt', 'message', 'text', 'id']) {
        const v = args[k];
        if (typeof v === 'string' && v.trim()) return oneLine(v, 96);
        if (Array.isArray(v) && typeof v[0] === 'string') return oneLine(v.join(' | '), 96);
    }
    return null;
}

function editTarget(tool: Pick<ToolCall, 'name' | 'input' | 'result' | 'state'>): string | null {
    const edits = patchEdits(tool);
    const first = edits[0]?.path || readInfo(tool).path;
    if (!first) return null;
    return edits.length > 1 ? `${basename(first)} +${edits.length - 1}` : basename(first);
}

function secondsLabel(sec: number): string {
    if (sec < 60) return `${Math.round(sec)}s`;
    if (sec < 3600) return `${Math.round(sec / 60)}m`;
    return `${Math.round(sec / 360) / 10}h`;
}

/**
 * Verb + key parameter for the tool row. Returns null for tools whose row
 * the caller renders itself (built-ins, sub-agents) — see `toolInfo.ts`.
 */
export function toolHeader(tool: Pick<ToolCall, 'name' | 'input' | 'result' | 'state'>): ToolHeader | null {
    const input = obj(tool.input);
    const head = (verb: ToolVerb, detail: string | null, mono = true): ToolHeader => ({ label: toolVerbLabel(verb), detail, mono });
    const cmd = commandInfo(tool);
    if (cmd) return head('run', oneLine(cmd.command, 200));
    switch (tool.name) {
        case 'Read':
        case 'read':
        case 'NotebookRead': {
            const r = readInfo(tool);
            return head('read', r.path ? `${basename(r.path)}${r.range ? `:${r.range}` : ''}` : null);
        }
        case 'Write': return head('write', str(input.file_path) ? basename(str(input.file_path)!) : null);
        case 'Edit':
        case 'NotebookEdit': return head('edit', readInfo(tool).path ? basename(readInfo(tool).path!) : null);
        case 'MultiEdit': {
            const p = str(input.file_path);
            const n = Array.isArray(input.edits) ? input.edits.length : 0;
            return head('edit', p ? `${basename(p)}${n > 1 ? ` · ${t('tools.card.edits', { count: n })}` : ''}` : null);
        }
        case 'Grep': return head('search', str(input.pattern) ? `"${oneLine(str(input.pattern)!, 80)}"${str(input.path) ? ` · ${str(input.path)}` : ''}` : null);
        case 'Glob': return head('find', str(input.pattern));
        case 'LS': return head('list', str(input.path));
        case 'TodoWrite': {
            const todos = Array.isArray(input.todos) ? input.todos.map(obj) : [];
            const done = todos.filter((x) => x.status === 'completed').length;
            return head('todo', todos.length ? t('tools.card.todoProgress', { done, total: todos.length }) : null, false);
        }
        case 'Monitor': return head('watch', str(input.description) ? oneLine(str(input.description)!) : str(input.command) ? oneLine(str(input.command)!) : null, !str(input.description));
        case 'TaskStop': return head('stopTask', str(input.task_id) ?? str(input.shell_id));
        case 'SendMessage': {
            const to = str(input.to) ?? str(input.recipient);
            const shortTo = to && to.length > 14 ? `${to.slice(0, 8)}…` : to;
            const what = str(input.summary) ?? (str(input.message) ? oneLine(str(input.message)!, 80) : null);
            return head('message', [shortTo ? t('tools.builtin.to', { target: shortTo }) : null, what].filter(Boolean).join(' · ') || null, false);
        }
        case 'ScheduleWakeup': {
            const delay = num(input.delaySeconds);
            const reason = str(input.reason);
            return head('wakeup', [delay !== null ? t('tools.card.inDuration', { duration: secondsLabel(delay) }) : null, reason ? oneLine(reason, 80) : null].filter(Boolean).join(' · ') || null, false);
        }
        case 'CronCreate': return head('schedule', [str(input.cron), str(input.prompt) ? oneLine(str(input.prompt)!, 72) : null].filter(Boolean).join(' · ') || null, false);
        case 'PushNotification': return head('notify', str(input.message) ? oneLine(str(input.message)!) : null, false);
        case 'ListAgents': return head('listAgents', null);
        case 'Workflow': {
            const name = /name:\s*['"]([^'"]+)['"]/.exec(str(input.script) ?? '')?.[1] ?? str(input.name);
            return head('workflow', name ?? null);
        }
        case 'Artifact': return head('publish', str(input.description) ? oneLine(str(input.description)!) : str(input.file_path) ? basename(str(input.file_path)!) : str(input.url), !str(input.description));
        case 'CodexReasoning':
        case 'GeminiReasoning': return head('think', str(input.title) ? oneLine(str(input.title)!) : null, false);
        default: break;
    }
    if (isPatchTool(tool)) return head('edit', editTarget(tool));
    const acp = acpInfo(tool);
    if (acp) {
        const title = acp.title ? oneLine(acp.title, 160) : null;
        switch (acp.kind) {
            case 'read': return head('read', readInfo(tool).path ? basename(readInfo(tool).path!) : title);
            case 'search': return head('search', title);
            case 'fetch': return head('fetch', fetchUrl(tool) ? shortUrl(fetchUrl(tool)!) : title);
            case 'think': return head('think', title, false);
            case 'delete': return head('delete', title);
            case 'move': return head('move', title);
            default: {
                // pi tools without a Claude twin keep their own name as the label.
                const piTool = str(input.piTool);
                return { label: piTool ?? title ?? tool.name, detail: piTool ? keyArg(acp.raw) ?? (title !== piTool ? title : null) : null, mono: false };
            }
        }
    }
    const kind = toolCardKind(tool);
    if (kind === 'webSearch') return head('searchWeb', searchQuery(tool), false);
    if (kind === 'fetch') return head('fetch', fetchUrl(tool) ? shortUrl(fetchUrl(tool)!) : null);
    if (tool.name === 'CodexCollaboration') return { label: `Codex · ${str(input.operation) ?? 'agent'}`, detail: str(input.prompt) ? oneLine(str(input.prompt)!) : null, mono: false };
    const mcp = mcpIdentity(tool);
    if (mcp) return { label: `${mcp.server} · ${mcp.tool}`, detail: keyArg(mcp.args), mono: false };
    return null;
}
