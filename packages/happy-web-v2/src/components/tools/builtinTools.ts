/**
 * Built-in very-happy tool calls (B-499).
 *
 * Every tool the CLI injects into a session — the in-process Claude MCP server
 * (`startHappyServer.ts`: change_title / copy_to_clipboard / open_preview /
 * report_progress, the 14 `team_*`, the 12 `automation_*`, and the assistant
 * variant's `sessions_*` / `terminal*` / `memory_update` / `journal_append`),
 * the Codex stdio bridge, pi over HAPPY_MCP_URL and the standalone
 * `very-happy mcp` server — is given ONE identity here regardless of the name
 * shape the runner reported it under:
 *
 *   - Claude SDK:   `mcp__happy__team_delegate` (server prefix; also
 *                   `mcp__very-happy__…` / `mcp__very-happy-clipboard__…`)
 *   - Gemini:       `happy__change_title`
 *   - Codex:        `McpTool` + `{ server: 'happy', tool, arguments }`
 *   - pi (B-353):   `other` + `{ piTool, rawInput }`
 *   - bare:         `team_delegate` (bridge-normalised or historical)
 *
 * On top of the identity it derives what the chat needs instead of raw JSON:
 * a verb label + one-line human detail for the row, structured fields for the
 * expanded card, and a digest of the result (links to /session, /teams …).
 *
 * Pure: never throws, never mutates; every accessor tolerates the partial
 * input the SDK streams before a call is complete.
 */
import type { ToolCall } from '@/sync/typesMessage';
import { AutomationActionSchema, AutomationTriggerSchema } from '@slopus/happy-wire';
import { getCurrentLanguage, t } from '@/text';
import { spawnedSessionIdOf } from '@/screens/session/spawnedSessionId';
import { describeAction, describeInterval, describeTrigger, fmtAbsolute, fmtSpan, langOf } from '@/screens/automations/automationPresentation';

export const BUILTIN_TOOL_NAMES = [
    'change_title', 'copy_to_clipboard', 'open_preview', 'report_progress',
    'team_create', 'team_join', 'team_inspect', 'team_delegate', 'team_message', 'team_submit', 'team_accept',
    'team_return', 'team_cancel', 'team_handoff',
    'team_schedule_create', 'team_schedule_pause', 'team_schedule_resume', 'team_schedule_cancel',
    'automation_list', 'automation_get', 'automation_create', 'automation_update', 'automation_pause',
    'automation_resume', 'automation_delete', 'automation_run', 'automation_fire', 'automation_runs',
    'automation_report', 'automation_ack',
    'sessions_list', 'session_read', 'session_send', 'session_spawn', 'session_kill', 'session_archive',
    'session_message', 'session_peers',
    'terminals_list', 'terminal_read', 'terminal_send', 'memory_update', 'journal_append',
] as const;
export type BuiltinToolName = typeof BUILTIN_TOOL_NAMES[number];
const NAME_SET: ReadonlySet<string> = new Set(BUILTIN_TOOL_NAMES);

export function isBuiltinToolName(name: unknown): name is BuiltinToolName {
    return typeof name === 'string' && NAME_SET.has(name);
}

export interface ResolvedBuiltinTool {
    name: BuiltinToolName;
    /** The tool's own arguments, unwrapped from any runner envelope. */
    input: Record<string, unknown>;
    via: 'bare' | 'mcp' | 'codex' | 'pi';
    server: string | null;
}

// ── small tolerant accessors ────────────────────────────────────────────────
function obj(v: unknown): Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
function str(v: unknown): string | null {
    return typeof v === 'string' && v.trim() !== '' ? v : null;
}
function num(v: unknown): number | null {
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
function strList(v: unknown): string[] {
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : [];
}

/** A foreign MCP server may legitimately expose a `session_send`; only ours count. */
function ownServer(server: string | null): boolean {
    return server === null || /happy/i.test(server);
}

export function resolveBuiltinTool(tool: Pick<ToolCall, 'name' | 'input'>): ResolvedBuiltinTool | null {
    const input = obj(tool.input);
    if (isBuiltinToolName(input.piTool)) return { name: input.piTool, input: obj(input.rawInput), via: 'pi', server: null };
    if (tool.name === 'McpTool') {
        const server = str(input.server);
        const name = input.tool;
        if (isBuiltinToolName(name) && ownServer(server)) return { name, input: obj(input.arguments), via: 'codex', server };
        return null;
    }
    if (typeof tool.name !== 'string') return null;
    if (isBuiltinToolName(tool.name)) return { name: tool.name, input, via: 'bare', server: null };
    const bare = tool.name.startsWith('mcp__') ? tool.name.slice('mcp__'.length) : tool.name;
    const cut = bare.lastIndexOf('__');
    if (cut <= 0) return null;
    const server = bare.slice(0, cut);
    const name = bare.slice(cut + 2);
    if (!isBuiltinToolName(name) || !ownServer(server)) return null;
    return { name, input, via: 'mcp', server };
}

// ── formatting helpers ───────────────────────────────────────────────────────
export function shortId(id: string): string {
    return id.length > 14 ? `${id.slice(0, 8)}…` : id;
}
export function oneLine(text: string, max = 96): string {
    const line = text.replace(/\s+/g, ' ').trim();
    return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
function basename(p: string): string {
    const parts = p.replace(/\/+$/, '').split('/');
    return parts[parts.length - 1] || p;
}
function agentName(agent: string | null): string | null {
    if (!agent) return null;
    if (agent === 'claude') return 'Claude';
    if (agent === 'codex') return 'Codex';
    if (agent === 'pi-acp' || agent === 'pi') return 'pi';
    if (agent === 'terminal-mirror') return 'Terminal';
    return agent;
}
function chars(n: number): string {
    return n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n);
}

/** Current UI language for the B-498 presentation helpers (which branch zh/en without t()). */
function lang() {
    return langOf(getCurrentLanguage());
}
function when(ms: number): string {
    return fmtAbsolute(ms, lang());
}

/** Human trigger via B-498's `describeTrigger`, e.g. "Daily at 09:00 · Asia/Singapore"; null for shapes the wire schema rejects (partial input). */
export function describeAutomationTrigger(trigger: unknown): string | null {
    const parsed = AutomationTriggerSchema.safeParse(trigger);
    return parsed.success ? describeTrigger(parsed.data, lang()).summary : null;
}

/** Human action headline via B-498's `describeAction`, e.g. "codex · /home/me/app"; null when the shape is incomplete. */
export function describeAutomationAction(action: unknown): string | null {
    const parsed = AutomationActionSchema.safeParse(action);
    return parsed.success ? describeAction(parsed.data, lang()).headline : null;
}

function attentionLabel(v: unknown): string | null {
    if (v === 'review') return t('tools.builtin.attention.review');
    if (v === 'blocked') return t('tools.builtin.attention.blocked');
    return null;
}

/** B-497 `session_peers` scope → human label; null for absent/unknown scopes. */
function scopeLabel(v: unknown): string | null {
    return v === 'repo' || v === 'cwd' || v === 'machine' ? t(`tools.builtin.scope.${v}` as 'tools.builtin.scope.repo') : null;
}

function automationRef(input: Record<string, unknown>): string | null {
    return str(input.name) ?? (str(input.id) ? shortId(str(input.id)!) : null);
}

// ── row summary ──────────────────────────────────────────────────────────────
export interface BuiltinToolSummary {
    label: string;
    detail: string | null;
}

export function builtinToolLabel(name: BuiltinToolName): string {
    return t(`tools.builtin.labels.${name}` as 'tools.builtin.labels.change_title');
}

export function builtinToolSummary(r: ResolvedBuiltinTool): BuiltinToolSummary {
    const label = builtinToolLabel(r.name);
    const i = r.input;
    const join = (...parts: Array<string | null | undefined>) => {
        const kept = parts.filter((p): p is string => typeof p === 'string' && p.trim() !== '');
        return kept.length ? kept.join(' · ') : null;
    };
    const line = (v: unknown, max?: number) => (str(v) ? oneLine(str(v)!, max) : null);
    const sid = (v: unknown) => (str(v) ? shortId(str(v)!) : null);
    let detail: string | null;
    switch (r.name) {
        case 'change_title': detail = line(i.title); break;
        case 'copy_to_clipboard': {
            const text = str(i.text);
            detail = text ? join(oneLine(text, 72), text.length > 72 ? t('tools.builtin.chars', { count: chars(text.length) }) : null) : null;
            break;
        }
        case 'open_preview': detail = line(i.path); break;
        case 'report_progress': detail = join(attentionLabel(i.attention), line(i.progress)); break;
        case 'team_create': detail = line(i.name); break;
        case 'team_join': detail = join(line(i.name), sid(i.teamId)); break;
        case 'team_inspect': detail = null; break;
        case 'team_delegate': {
            const target = str(i.botName) ?? sid(i.assigneeBotId) ?? agentName(str(i.assistant));
            detail = join(target ? t('tools.builtin.to', { target }) : null, line(i.goal));
            break;
        }
        case 'team_message': detail = join(sid(i.recipientBotId), line(i.body)); break;
        case 'team_submit': detail = join(sid(i.taskId), line(i.result)); break;
        case 'team_accept': detail = sid(i.taskId); break;
        case 'team_return':
        case 'team_cancel': detail = join(sid(i.taskId), line(i.reason)); break;
        case 'team_handoff': detail = join(sid(i.taskId), sid(i.assigneeBotId) ? t('tools.builtin.to', { target: sid(i.assigneeBotId)! }) : null); break;
        case 'team_schedule_create': {
            const runAt = num(i.runAt);
            const every = num(i.intervalMs);
            detail = join(line(i.name), runAt ? when(runAt) : null, every ? describeInterval(every, lang()) : null);
            break;
        }
        case 'team_schedule_pause':
        case 'team_schedule_resume':
        case 'team_schedule_cancel': detail = sid(i.scheduleId); break;
        case 'automation_list': detail = str(i.machineId) && i.machineId !== 'this' ? sid(i.machineId) : null; break;
        case 'automation_get':
        case 'automation_pause':
        case 'automation_resume':
        case 'automation_delete': detail = automationRef(i); break;
        case 'automation_create': detail = join(line(i.name), describeAutomationTrigger(i.trigger), describeAutomationAction(i.action)); break;
        case 'automation_update': {
            const changed = ['newName', 'description', 'machineId', 'trigger', 'action', 'concurrency', 'maxRuntimeMs']
                .filter((k) => i[k] !== undefined)
                .map((k) => t(`tools.builtin.fields.${k === 'newName' ? 'name' : k}` as 'tools.builtin.fields.name'));
            detail = join(automationRef(i), changed.length ? changed.join(', ') : null, i.trigger !== undefined ? describeAutomationTrigger(i.trigger) : null);
            break;
        }
        case 'automation_run': detail = join(automationRef(i), line(i.payload, 48)); break;
        case 'automation_fire': detail = join(line(i.name), line(i.payload, 48), str(i.dedupeKey) ? `#${oneLine(str(i.dedupeKey)!, 24)}` : null); break;
        case 'automation_runs': detail = join(automationRef(i), line(i.status), i.attention === true ? t('tools.builtin.attentionOnly') : null); break;
        case 'automation_report': {
            const status = str(i.status);
            detail = join(status ? t(`tools.builtin.runStatus.${status}` as 'tools.builtin.runStatus.done') : null,
                i.needsAttention === true ? t('tools.builtin.attention.review') : null,
                line(i.summary) ?? line(i.error));
            break;
        }
        case 'automation_ack': detail = sid(i.runId); break;
        case 'sessions_list':
        case 'terminals_list': detail = null; break;
        case 'session_read': detail = join(sid(i.sessionId), num(i.limit) ? t('tools.builtin.lastN', { count: num(i.limit)! }) : null); break;
        case 'session_send': detail = join(sid(i.sessionId), line(i.text)); break;
        case 'session_spawn': detail = join(str(i.directory) ? basename(str(i.directory)!) : null, line(i.prompt)); break;
        case 'session_kill':
        case 'session_archive': detail = sid(i.sessionId); break;
        // B-497: peer messaging between sessions on one machine.
        case 'session_message': detail = join(sid(i.to) ? t('tools.builtin.to', { target: sid(i.to)! }) : null, line(i.body)); break;
        case 'session_peers': detail = scopeLabel(i.scope); break;
        case 'terminal_read': detail = join(line(i.terminalId, 24), num(i.lines) ? t('tools.builtin.lastN', { count: num(i.lines)! }) : null); break;
        case 'terminal_send': detail = join(line(i.terminalId, 24), line(i.text, 64), i.submit === true ? t('tools.builtin.fields.submit') : null); break;
        case 'memory_update': detail = line(i.section); break;
        case 'journal_append': detail = line(i.content); break;
    }
    return { label, detail };
}

// ── expanded card: structured fields ─────────────────────────────────────────
export interface BuiltinToolField {
    key: string;
    label: string;
    value: string;
    mono?: boolean;
    multiline?: boolean;
    items?: string[];
}

export function builtinToolFields(r: ResolvedBuiltinTool): BuiltinToolField[] {
    const i = r.input;
    const out: BuiltinToolField[] = [];
    const F = (key: string, label: string, value: string | null | undefined, opts: Partial<BuiltinToolField> = {}) => {
        if (value) out.push({ key, label, value, ...opts });
    };
    const L = (key: keyof typeof FIELD_KEYS) => t(`tools.builtin.fields.${key}` as 'tools.builtin.fields.name');
    const text = (key: keyof typeof FIELD_KEYS, v: unknown, mono = false) => F(key, L(key), str(v), { mono, multiline: (str(v)?.length ?? 0) > 96 || (str(v)?.includes('\n') ?? false) });
    const id = (key: keyof typeof FIELD_KEYS, v: unknown) => F(key, L(key), str(v), { mono: true });
    const at = (key: keyof typeof FIELD_KEYS, v: unknown) => F(key, L(key), num(v) ? when(num(v)!) : null, { mono: true });
    switch (r.name) {
        case 'change_title': text('title', i.title); break;
        case 'copy_to_clipboard': text('text', i.text, true); break;
        case 'open_preview': id('path', i.path); text('mode', i.mode); break;
        case 'report_progress': text('progress', i.progress); F('attention', L('attention'), attentionLabel(i.attention)); break;
        case 'team_create': text('name', i.name); id('machine', i.machineId); break;
        case 'team_join': text('name', i.name); id('team', i.teamId); id('bot', i.botId); break;
        case 'team_inspect': break;
        case 'team_delegate': {
            text('goal', i.goal);
            const acceptance = strList(i.acceptance);
            if (acceptance.length) out.push({ key: 'acceptance', label: L('acceptance'), value: String(acceptance.length), items: acceptance });
            F('assignee', L('assignee'), str(i.botName) ?? str(i.assigneeBotId), { mono: !str(i.botName) });
            F('agent', L('agent'), agentName(str(i.assistant)));
            text('model', i.model, true);
            id('directory', i.directory);
            id('parentTask', i.parentTaskId);
            break;
        }
        case 'team_message': id('task', i.taskId); id('recipient', i.recipientBotId); text('body', i.body); break;
        case 'team_submit': id('task', i.taskId); id('attempt', i.attemptId); text('result', i.result); break;
        case 'team_accept': id('task', i.taskId); id('attempt', i.attemptId); break;
        case 'team_return':
        case 'team_cancel': id('task', i.taskId); text('reason', i.reason); break;
        case 'team_handoff': id('task', i.taskId); id('assignee', i.assigneeBotId); break;
        case 'team_schedule_create':
            text('name', i.name); id('bot', i.botId); at('runAt', i.runAt);
            F('interval', L('interval'), num(i.intervalMs) ? fmtSpan(num(i.intervalMs)!) : null);
            text('body', i.body);
            break;
        case 'team_schedule_pause':
        case 'team_schedule_resume':
        case 'team_schedule_cancel': id('schedule', i.scheduleId); F('version', L('version'), num(i.version) ? `v${num(i.version)}` : null, { mono: true }); break;
        case 'automation_list': id('machine', i.machineId); break;
        case 'automation_get':
        case 'automation_pause':
        case 'automation_resume':
        case 'automation_delete': text('name', i.name); id('id', i.id); break;
        case 'automation_create':
        case 'automation_update': {
            text('name', i.name); id('id', i.id);
            if (r.name === 'automation_update') { F('version', L('version'), num(i.version) ? `v${num(i.version)}` : null, { mono: true }); text('newName', i.newName); }
            text('description', i.description);
            id('machine', i.machineId);
            if (i.trigger !== undefined) F('trigger', L('trigger'), describeAutomationTrigger(i.trigger) ?? oneLine(JSON.stringify(i.trigger)), { mono: obj(i.trigger).kind === 'cron' && !describeAutomationTrigger(i.trigger) });
            if (i.action !== undefined) {
                F('action', L('action'), describeAutomationAction(i.action) ?? oneLine(JSON.stringify(i.action)));
                const a = obj(i.action);
                text('prompt', a.prompt);
                if (a.kind === 'script') F('command', L('command'), strList(a.command).join(' '), { mono: true, multiline: true });
                id('directory', a.directory ?? a.cwd);
                if (obj(a.sticky).key) F('sticky', L('sticky'), str(obj(a.sticky).key), { mono: true });
            }
            F('concurrency', L('concurrency'), str(i.concurrency));
            F('maxRuntime', L('maxRuntime'), num(i.maxRuntimeMs) ? fmtSpan(num(i.maxRuntimeMs)!) : null);
            if (i.paused === true) F('status', L('status'), t('tools.builtin.status.paused'));
            break;
        }
        case 'automation_run': text('name', i.name); id('id', i.id); text('payload', i.payload, true); break;
        case 'automation_fire': text('name', i.name); text('payload', i.payload, true); id('dedupeKey', i.dedupeKey); break;
        case 'automation_runs': text('name', i.name); id('id', i.id); text('status', i.status); if (i.attention === true) F('attention', L('attention'), t('tools.builtin.attentionOnly')); F('limit', L('limit'), num(i.limit) ? String(num(i.limit)) : null); break;
        case 'automation_report':
            id('run', i.runId);
            F('status', L('status'), str(i.status) ? t(`tools.builtin.runStatus.${str(i.status)}` as 'tools.builtin.runStatus.done') : null);
            text('summary', i.summary); text('error', i.error);
            if (i.needsAttention === true) F('attention', L('attention'), str(i.attentionReason) ?? t('tools.builtin.attention.review'));
            break;
        case 'automation_ack': id('run', i.runId); break;
        case 'sessions_list':
        case 'terminals_list': break;
        case 'session_read': id('session', i.sessionId); F('limit', L('limit'), num(i.limit) ? String(num(i.limit)) : null); break;
        case 'session_send': id('session', i.sessionId); text('text', i.text); break;
        case 'session_spawn': id('directory', i.directory); text('prompt', i.prompt); break;
        case 'session_kill':
        case 'session_archive': id('session', i.sessionId); break;
        case 'session_message': id('to', i.to); id('replyTo', i.replyTo); text('body', i.body); break;
        case 'session_peers': F('scope', L('scope'), scopeLabel(i.scope)); break;
        case 'terminal_read': id('terminal', i.terminalId); F('lines', L('lines'), num(i.lines) ? String(num(i.lines)) : null); break;
        case 'terminal_send': id('terminal', i.terminalId); text('text', i.text, true); F('submit', L('submit'), i.submit === true ? t('tools.builtin.yes') : t('tools.builtin.no')); break;
        case 'memory_update': text('section', i.section); text('content', i.content); break;
        case 'journal_append': text('content', i.content); break;
    }
    return out;
}

/** Keys of `tools.builtin.fields` — kept as a const object so the accessor above is typed. */
const FIELD_KEYS = {
    title: 1, text: 1, path: 1, mode: 1, progress: 1, attention: 1, name: 1, newName: 1, id: 1, machine: 1, team: 1, bot: 1, goal: 1,
    acceptance: 1, assignee: 1, agent: 1, model: 1, directory: 1, parentTask: 1, task: 1, recipient: 1, body: 1, result: 1,
    reason: 1, attempt: 1, schedule: 1, runAt: 1, interval: 1, version: 1, description: 1, trigger: 1, action: 1, prompt: 1,
    command: 1, sticky: 1, concurrency: 1, maxRuntime: 1, maxRuntimeMs: 1, status: 1, payload: 1, dedupeKey: 1, limit: 1, run: 1,
    summary: 1, error: 1, session: 1, terminal: 1, lines: 1, submit: 1, section: 1, content: 1,
    to: 1, replyTo: 1, scope: 1,
} as const;

// ── result digest ────────────────────────────────────────────────────────────
export interface BuiltinToolLink { to: string; label: string; id: string }
export interface BuiltinToolDigest {
    /** Short human lines summarising a structured (JSON) result. */
    lines: string[];
    links: BuiltinToolLink[];
    /** Full raw text of the result (for the collapsible raw section / prose results). */
    text: string;
    /** Parsed JSON when the result was one; null for prose or errors. */
    json: unknown;
    error: string | null;
}

/** MCP results reach the web as a string, `[{ type:'text', text }]`, or `{ content: [...] }`. */
export function builtinResultText(result: unknown): string {
    if (result == null) return '';
    if (typeof result === 'string') return result;
    if (Array.isArray(result)) {
        const joined = result.map((b) => (typeof obj(b).text === 'string' ? (obj(b).text as string) : null)).filter((s): s is string => s != null).join('\n');
        if (joined) return joined;
    } else if (typeof result === 'object') {
        const r = result as Record<string, unknown>;
        if ('content' in r) { const inner = builtinResultText(r.content); if (inner) return inner; }
        for (const key of ['text', 'output', 'result', 'error', 'message']) if (typeof r[key] === 'string') return r[key] as string;
    }
    try { return JSON.stringify(result, null, 2); } catch { return String(result); }
}

function parseJson(text: string): unknown {
    const s = text.trim();
    if (!(s.startsWith('{') || s.startsWith('['))) return null;
    try { return JSON.parse(s); } catch { return null; }
}

/** B-498 detail route. Only reachable by id: a name-only reference (no result yet) shows the name without a link. */
export function automationHref(id: string): string {
    return `/automations/${encodeURIComponent(id)}`;
}

function automationLine(a: Record<string, unknown>): string {
    const parts = [str(a.name) ?? (str(a.id) ? shortId(str(a.id)!) : '?')];
    const trigger = describeAutomationTrigger(a.trigger);
    if (trigger) parts.push(trigger);
    const status = str(a.status);
    if (status && status !== 'active') parts.push(t(`tools.builtin.status.${status}` as 'tools.builtin.status.paused'));
    const next = num(a.nextRunAt);
    if (next && status !== 'paused') parts.push(t('tools.builtin.nextRun', { at: when(next) }));
    return parts.join(' · ');
}

function runLine(run: Record<string, unknown>): string {
    const parts: string[] = [];
    const status = str(run.status);
    if (status) parts.push(t(`tools.builtin.runStatus.${status}` as 'tools.builtin.runStatus.done'));
    const id = str(run.id);
    if (id) parts.push(shortId(id));
    const summary = str(run.summary) ?? str(run.error);
    if (summary) parts.push(oneLine(summary, 80));
    if (run.needsAttention === true) parts.push(t('tools.builtin.attention.review'));
    return parts.join(' · ');
}

export function builtinToolDigest(r: ResolvedBuiltinTool, tool: Pick<ToolCall, 'result' | 'state'>): BuiltinToolDigest {
    const text = builtinResultText(tool.result);
    const digest: BuiltinToolDigest = { lines: [], links: [], text, json: null, error: null };
    if (tool.state === 'error') {
        digest.error = text.trim() || t('tools.fullView.error');
        return digest;
    }
    const json = parseJson(text);
    digest.json = json;
    const j = obj(json);
    const addLink = (to: string, label: string, id: string) => {
        if (!digest.links.some((l) => l.to === to)) digest.links.push({ to, label, id });
    };
    const sessionLink = (id: string | null) => { if (id) addLink(`/session/${id}`, t('tools.builtin.openSession'), id); };
    const teamLink = (teamId: string | null, taskId: string | null) => {
        if (!teamId) return;
        if (taskId) addLink(`/teams/${encodeURIComponent(teamId)}?task=${encodeURIComponent(taskId)}`, t('tools.builtin.openTask'), taskId);
        else addLink(`/teams/${encodeURIComponent(teamId)}`, t('tools.builtin.openTeam'), teamId);
    };
    const automationLink = (id: string | null) => {
        if (id) addLink(automationHref(id), t('tools.builtin.openAutomation'), id);
    };
    const i = r.input;

    if (r.name.startsWith('team_')) {
        const team = obj(j.team);
        const teamId = str(team.id) ?? str(i.teamId);
        const taskId = str(j.taskId) ?? str(i.taskId);
        if (json !== null) {
            if (r.name === 'team_create' || r.name === 'team_join') {
                const name = str(team.name);
                const bots = Array.isArray(team.bots) ? team.bots.length : null;
                if (name) digest.lines.push(bots != null ? t('tools.builtin.teamSummary', { name, members: bots }) : name);
                teamLink(teamId, null);
            } else if (r.name === 'team_inspect') {
                const tasks = Array.isArray(team.tasks) ? team.tasks.length : 0;
                const bots = Array.isArray(team.bots) ? team.bots.length : 0;
                const messages = Array.isArray(team.messages) ? team.messages.length : 0;
                if (str(team.name)) digest.lines.push(t('tools.builtin.inspectSummary', { name: str(team.name)!, tasks, bots, messages }));
                teamLink(teamId, null);
            } else if (r.name.startsWith('team_schedule_')) {
                const scheduleId = str(j.scheduleId) ?? str(i.scheduleId);
                if (scheduleId) digest.lines.push(t('tools.builtin.scheduleRef', { id: shortId(scheduleId) }));
                teamLink(teamId, null);
            } else {
                if (taskId) {
                    const task = (Array.isArray(team.tasks) ? team.tasks : []).map(obj).find((task) => task.id === taskId);
                    const status = task ? str(task.status) : null;
                    digest.lines.push([t('tools.builtin.taskRef', { id: shortId(taskId) }), status ? t(`tools.builtin.taskStatus.${status}` as 'tools.builtin.taskStatus.queued') : null].filter(Boolean).join(' · '));
                }
                teamLink(teamId, taskId);
            }
        } else {
            teamLink(teamId, taskId);
        }
        return digest;
    }

    if (r.name.startsWith('automation_')) {
        if (json === null) return digest;
        if (Array.isArray(j.automations)) {
            const list = j.automations.map(obj);
            digest.lines.push(t('tools.builtin.automationCount', { count: list.length }));
            for (const a of list.slice(0, 8)) digest.lines.push(automationLine(a));
            if (list.length > 8) digest.lines.push(`+${list.length - 8}`);
            return digest;
        }
        if (Array.isArray(j.runs)) {
            const list = j.runs.map(obj);
            digest.lines.push(t('tools.builtin.runCount', { count: list.length }));
            for (const run of list.slice(0, 8)) digest.lines.push(runLine(run));
            if (list.length > 8) digest.lines.push(`+${list.length - 8}`);
            return digest;
        }
        if (j.deleted === true) {
            digest.lines.push(t('tools.builtin.deleted', { name: str(j.name) ?? (str(j.id) ? shortId(str(j.id)!) : '') }));
            return digest;
        }
        if (typeof j.automation === 'object' && j.automation) {
            const a = obj(j.automation);
            digest.lines.push(automationLine(a));
            const action = describeAutomationAction(a.action);
            if (action) digest.lines.push(action);
            automationLink(str(a.id));
            return digest;
        }
        if (typeof j.run === 'object' && j.run) {
            const run = obj(j.run);
            digest.lines.push(runLine(run));
            automationLink(str(run.automationId));
            sessionLink(str(run.sessionId));
            return digest;
        }
        // automation_fire returns the run envelope directly.
        if (str(j.status) && str(j.id)) {
            digest.lines.push(runLine(j));
            automationLink(str(j.automationId));
            sessionLink(str(j.sessionId));
        }
        return digest;
    }

    switch (r.name) {
        case 'session_spawn':
            sessionLink(spawnedSessionIdOf(text));
            break;
        case 'session_send':
        case 'session_read':
        case 'session_kill':
        case 'session_archive':
            sessionLink(str(i.sessionId));
            break;
        // B-497: `{ delivered, messageId, to, url }` — link the recipient either way.
        case 'session_message':
            if (json !== null && j.delivered === true) digest.lines.push(t('tools.builtin.messageDelivered'));
            sessionLink(str(j.to) ?? str(i.to));
            break;
        // B-497: `{ self, scope, peers: [{ sessionId, kind, cwd, flavor, title, edits }] }`.
        case 'session_peers': {
            if (json === null || !Array.isArray(j.peers)) break;
            const peers = j.peers.map(obj);
            digest.lines.push(t('tools.builtin.peerCount', { count: peers.length }));
            for (const peer of peers.slice(0, 8)) {
                const sessionId = str(peer.sessionId);
                const edits = Array.isArray(peer.edits) ? peer.edits.length : 0;
                const parts = [str(peer.title) ?? (sessionId ? shortId(sessionId) : '?'), agentName(str(peer.flavor)), str(peer.cwd) ? basename(str(peer.cwd)!) : null,
                    edits > 0 ? t('tools.builtin.editedFiles', { count: edits }) : null];
                digest.lines.push(parts.filter((p): p is string => !!p).join(' · '));
                sessionLink(sessionId);
            }
            if (peers.length > 8) digest.lines.push(`+${peers.length - 8}`);
            break;
        }
        default:
            break;
    }
    return digest;
}
