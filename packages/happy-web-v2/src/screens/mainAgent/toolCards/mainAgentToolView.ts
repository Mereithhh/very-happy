/**
 * B-923: main agent tool calls → a semantic card model (pure, no React).
 *
 * The main agent's tools (specs/2026-11-main-agent.md §3.2, CLI
 * assistant/mainAgentTools.ts, assistantTools.ts, gates/dispatchGate.ts,
 * attention/tools.ts, sessions/peerTools.ts) answer either a JSON receipt or
 * one line of text. This module reads the call's input (always structured)
 * and its result (JSON when it parses, text otherwise) into a
 * language-neutral view; MainAgentToolCard turns codes into copy.
 *
 * Unknown tools return null → the transcript keeps its generic row. Nothing
 * here throws on odd shapes: every field is optional and checked.
 */

import type { ToolCall } from '@/sync/typesMessage';

export type ToolCardKind =
    | 'delegate' | 'lead-message' | 'session' | 'issue' | 'todo' | 'note' | 'board'
    | 'decision' | 'lifecycle' | 'list' | 'blocked' | 'unavailable' | 'error';

/** Status codes the card shows as a pill (copy in mainAgentToolCopy). */
export type ToolStatus =
    | 'running' | 'delivered' | 'stored' | 'sent' | 'spawned' | 'done' | 'recorded' | 'posted' | 'updated' | 'resolved'
    | 'queued' | 'in-progress' | 'scheduled-idle' | 'scheduled-now' | 'already'
    | 'awaiting' | 'approved' | 'draft-only' | 'dropped' | 'not-approved'
    | 'blocked' | 'not-available' | 'failed';

export type ToolTone = 'live' | 'ok' | 'warn' | 'danger' | 'neutral';

export type ToolLink =
    | { kind: 'session'; sessionId: string; role: 'lead' | 'target' | 'from' | 'to' }
    | { kind: 'board' }
    | { kind: 'settings' }
    | { kind: 'issue'; ref: string };

export type ToolField = { key: FieldKey; value: string; mono?: boolean };
export type FieldKey =
    | 'team' | 'lead' | 'task' | 'directory' | 'agent' | 'title' | 'risk' | 'kind' | 'session' | 'from' | 'to'
    | 'when' | 'version' | 'key' | 'assignee' | 'priority' | 'project' | 'terminal' | 'approval' | 'choice' | 'outcome';

export interface ToolCardView {
    kind: ToolCardKind;
    /** bare tool name (mcp__happy__ prefix stripped) */
    tool: string;
    status: ToolStatus;
    /** main line: team / issue / todo title, list count … (data, not copy) */
    heading?: string;
    fields: ToolField[];
    /** text handed to someone else (goal, body, prompt) or the note body */
    preview?: string;
    /** acceptance criteria, list lines, decision options */
    items?: string[];
    /** list rows past the shown ones */
    more?: number;
    links: ToolLink[];
    /** machine-readable error / refusal code from the receipt (lead_unreachable, card_tampered …) */
    errorCode?: string;
    /** free text from the receipt or the tool's error line */
    errorText?: string;
    /** raw input + result for the expandable details */
    raw: { input: unknown; result: string | null };
}

export const STATUS_TONE: Record<ToolStatus, ToolTone> = {
    running: 'live', delivered: 'ok', stored: 'neutral', sent: 'ok', spawned: 'ok', done: 'ok', recorded: 'ok', posted: 'ok', updated: 'ok', resolved: 'ok',
    queued: 'neutral', 'in-progress': 'live', 'scheduled-idle': 'neutral', 'scheduled-now': 'ok', already: 'neutral',
    awaiting: 'warn', approved: 'ok', 'draft-only': 'neutral', dropped: 'neutral', 'not-approved': 'danger',
    blocked: 'danger', 'not-available': 'neutral', failed: 'danger',
};

/** PreToolUse deny reason of gate 1 (CLI gates/outboundDenylist.ts OUTBOUND_DENY_REASON). */
export const OUTBOUND_DENY_MARKER = '主 agent 不能直接对外发送';

const LIST_SHOWN = 6;

/** `mcp__happy__lead_delegate` → `lead_delegate`; other servers keep their full name (never a main agent tool). */
export function bareToolName(name: string): string {
    const m = /^mcp__happy__(.+)$/.exec(name);
    return m ? m[1] : name;
}

/** The tool's answer as text: string, MCP content blocks, or anything JSON-able. */
export function toolResultText(result: unknown): string | null {
    if (result === undefined || result === null) return null;
    if (typeof result === 'string') return result;
    if (Array.isArray(result)) {
        const parts = result.map((b) => (b && typeof b === 'object' && typeof (b as { text?: unknown }).text === 'string' ? (b as { text: string }).text : typeof b === 'string' ? b : null));
        if (parts.every((p) => p !== null)) return parts.join('\n');
    }
    if (typeof result === 'object' && Array.isArray((result as { content?: unknown }).content)) return toolResultText((result as { content: unknown }).content);
    try { return JSON.stringify(result); } catch { return String(result); }
}

type Rec = Record<string, unknown>;
function parseJson(text: string | null): Rec | null {
    if (!text) return null;
    const t = text.trim();
    if (!t.startsWith('{')) return null;
    try {
        const v = JSON.parse(t);
        return v && typeof v === 'object' && !Array.isArray(v) ? v as Rec : null;
    } catch { return null; }
}
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
function field(key: FieldKey, value: unknown, mono = false): ToolField[] {
    const s = typeof value === 'number' ? String(value) : str(value);
    return s ? [{ key, value: s, ...(mono ? { mono } : {}) }] : [];
}
const SESSION_IN_TEXT = /\/session\/([A-Za-z0-9_-]{6,})/;
function sessionLink(id: unknown, role: Extract<ToolLink, { kind: 'session' }>['role']): ToolLink[] {
    const s = str(id);
    return s && /^[A-Za-z0-9_-]{1,128}$/.test(s) ? [{ kind: 'session', sessionId: s, role }] : [];
}
function lines(text: string | null): string[] {
    return (text ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
}

/** Dispatch tools behind gate 2 (CLI gates/dispatchGate.ts DISPATCH_TOOL_PAYLOADS). */
const DISPATCH_TOOLS = new Set(['session_spawn', 'session_send', 'terminal_send', 'team_delegate', 'team_message', 'lead_delegate', 'lead_message', 'session_message', 'automation_create', 'automation_update']);

const KNOWN = new Set([
    'teams_list', 'lead_delegate', 'lead_message',
    'issue_list', 'issue_create', 'issue_assign', 'issue_comment', 'issue_get',
    'todo_list', 'todo_add', 'todo_complete',
    'project_list', 'project_context', 'project_note',
    'session_wrapup', 'session_handoff', 'session_restart',
    'sessions_list', 'session_read', 'session_send', 'session_spawn', 'session_kill', 'session_archive',
    'session_message', 'session_peers',
    'terminals_list', 'terminal_read', 'terminal_send',
    'owner_board_post', 'owner_board_update', 'owner_board_resolve', 'owner_board_list',
    'dispatch_approved', 'automation_create', 'automation_update',
]);

/** Gate 1 (outbound denylist) refused the call — any tool, the main agent's or a third-party MCP one. */
export function isGateBlocked(tool: Pick<ToolCall, 'state' | 'result' | 'permission'>): boolean {
    const reason = tool.permission?.status === 'denied' ? tool.permission.reason ?? '' : '';
    if (reason.includes(OUTBOUND_DENY_MARKER)) return true;
    if (tool.state !== 'error') return false;
    return (toolResultText(tool.result) ?? '').includes(OUTBOUND_DENY_MARKER);
}

/** null = not a main agent tool → the caller keeps its generic row. */
export function mainAgentToolView(tool: Pick<ToolCall, 'name' | 'state' | 'input' | 'result' | 'permission'>): ToolCardView | null {
    const name = bareToolName(tool.name);
    const input = (tool.input && typeof tool.input === 'object' ? tool.input : {}) as Rec;
    const text = toolResultText(tool.result);
    const raw = { input: tool.input ?? null, result: text };
    const base = { tool: name, fields: [] as ToolField[], links: [] as ToolLink[], raw };

    if (isGateBlocked(tool)) {
        return { ...base, kind: 'blocked', status: 'blocked', links: [{ kind: 'settings' }], errorText: text ?? tool.permission?.reason ?? undefined };
    }
    if (!KNOWN.has(name)) return null;

    const json = parseJson(text);
    const running = tool.state === 'running';
    const isError = tool.state === 'error' || json?.ok === false;
    // `error` is a code (`lead_unreachable`) or, in B-919 lifecycle receipts, a one-line message
    const errorField = str(json?.error);
    const errorCode = errorField && /^[a-z][a-z_:-]*$/.test(errorField) ? errorField : undefined;
    const errorMessage = errorCode ? str(json?.detail) : errorField ?? str(json?.detail);

    if (running) {
        const pending = describe(name, input, null, null, false);
        return { ...pending, status: 'running', raw, ...(pending.kind === 'list' ? { heading: undefined, items: undefined, more: undefined } : {}) };
    }

    // gate 2 interceptions answer for any dispatch tool
    if (DISPATCH_TOOLS.has(name) && json) {
        if (json.state === 'awaiting_decision') return decisionView(base, json, input);
        if (errorCode === 'risk_required' || errorCode === 'board_unavailable') {
            return { ...describe(name, input, json, text, true), kind: 'error', status: 'failed', errorCode, errorText: errorMessage, raw };
        }
    }
    if (name === 'dispatch_approved') return approvedView(base, json, input, text, isError);
    if (errorCode === 'not_available') {
        return { ...base, kind: 'unavailable', status: 'not-available', errorCode, errorText: errorMessage };
    }
    const view = describe(name, input, json, text, isError);
    if (isError) {
        return { ...view, status: 'failed', errorCode: errorCode ?? view.errorCode, errorText: errorMessage ?? view.errorText ?? (json ? undefined : text ?? undefined) };
    }
    return view;
}

function decisionView(base: Omit<ToolCardView, 'kind' | 'status'>, json: Rec, input: Rec): ToolCardView {
    const payload = str(input.goal) ?? str(input.body) ?? str(input.prompt) ?? str(input.text);
    return {
        ...base, kind: 'decision', status: 'awaiting',
        fields: [...field('risk', json.risk), ...field('approval', json.approvalId, true)],
        preview: payload,
        links: [{ kind: 'board' }],
    };
}

function approvedView(base: Omit<ToolCardView, 'kind' | 'status'>, json: Rec | null, input: Rec, text: string | null, isError: boolean): ToolCardView {
    const approval = { ...base, kind: 'decision' as const, fields: [...field('approval', json?.approvalId ?? input.approvalId ?? input.boardItemId, true)], links: [{ kind: 'board' } as ToolLink] };
    const state = str(json?.state);
    const err = str(json?.error);
    if (state === 'dispatched') return { ...approval, status: 'approved', fields: [...approval.fields, ...field('choice', json?.choice)], preview: str(json?.result) };
    if (state === 'draft_only') return { ...approval, status: 'draft-only' };
    if (state === 'dropped') return { ...approval, status: 'dropped' };
    if (state === 'already_dispatched') return { ...approval, status: 'already', preview: str(json?.result) };
    if (err === 'awaiting_decision') return { ...approval, status: 'awaiting' };
    if (err === 'not_approved') return { ...approval, status: 'not-approved', errorCode: err };
    if (state === 'dispatch_failed') return { ...approval, status: 'failed', errorCode: 'dispatch_failed', errorText: str(json?.result) };
    if (isError || err) return { ...approval, status: 'failed', errorCode: err, errorText: str(json?.detail) ?? (json ? undefined : text ?? undefined) };
    return { ...approval, status: 'done' };
}

/** The per-tool card (success shape; the caller overrides status on errors). */
function describe(name: string, input: Rec, json: Rec | null, text: string | null, isError: boolean): ToolCardView {
    const raw = { input, result: text };
    const v = (kind: ToolCardKind, status: ToolStatus, rest: Partial<ToolCardView> = {}): ToolCardView => ({ kind, tool: name, status, fields: [], links: [], raw, ...rest });

    switch (name) {
        case 'lead_delegate':
        case 'lead_message': {
            return v(name === 'lead_delegate' ? 'delegate' : 'lead-message', 'delivered', {
                // the receipt names the team; before it arrives (or on a refusal) the id is all there is
                heading: str(json?.team) ?? str(input.teamId),
                // a Lead bot is usually named "Lead": the link already says 「打开 Lead 会话」, so only a distinct name earns a field
                fields: [...(str(json?.lead) && str(json?.lead)!.trim().toLowerCase() !== 'lead' ? field('lead', json?.lead) : []), ...(name === 'lead_message' ? field('task', input.taskId, true) : [])],
                preview: name === 'lead_delegate' ? str(input.goal) : str(input.body),
                items: name === 'lead_delegate' && Array.isArray(input.acceptance) ? input.acceptance.filter((a): a is string => typeof a === 'string') : undefined,
                links: sessionLink(json?.leadSessionId, 'lead'),
            });
        }
        case 'session_spawn': {
            const spawned = /Spawned (?:idle session )?([A-Za-z0-9_-]+)/.exec(text ?? '')?.[1] ?? SESSION_IN_TEXT.exec(text ?? '')?.[1];
            const sendFailed = !isError && /sending the first prompt failed/.test(text ?? '');
            return v('session', 'spawned', {
                heading: str(input.title),
                fields: [...field('directory', input.directory, true), ...field('agent', input.agent)],
                preview: str(input.prompt),
                links: sessionLink(spawned, 'target'),
                ...(sendFailed ? { errorCode: 'first_prompt_failed' } : {}),
            });
        }
        case 'session_send':
        case 'session_message': {
            const target = name === 'session_send' ? input.sessionId : input.to;
            const stored = json?.stored === true && json?.delivered === false;
            return v('session', stored ? 'stored' : 'sent', {
                preview: str(input.text) ?? str(input.body),
                links: sessionLink(target, 'target'),
                fields: field('session', target, true),
            });
        }
        case 'session_read':
        case 'session_kill':
        case 'session_archive':
            return v('session', 'done', { fields: field('session', input.sessionId, true), links: sessionLink(input.sessionId, 'target'), preview: name === 'session_read' ? firstLine(text) : undefined });
        case 'terminal_send':
        case 'terminal_read': {
            const tid = str(input.terminalId);
            return v('session', name === 'terminal_send' ? 'sent' : 'done', {
                fields: field('terminal', tid, true),
                preview: name === 'terminal_send' ? str(input.text) : undefined,
                // a terminal route needs its machine id, which the call does not carry
            });
        }
        case 'issue_create':
        case 'issue_assign':
        case 'issue_comment':
        case 'issue_get': {
            const line = parseIssueLine(text);
            const ref = line?.key ?? str(input.key) ?? str(input.issue) ?? str(input.issueId);
            const assignee = input.assignee && typeof input.assignee === 'object' ? str((input.assignee as Rec).agent) : undefined;
            return v('issue', name === 'issue_get' ? 'done' : name === 'issue_comment' ? 'posted' : name === 'issue_create' ? 'done' : 'updated', {
                heading: line?.title ?? str(input.title),
                fields: [...field('key', ref, true), ...(line ? field('kind', line.status) : []), ...field('assignee', assignee), ...field('priority', input.priority)],
                preview: name === 'issue_comment' ? str(input.body) : name === 'issue_create' ? str(input.description) : undefined,
                links: ref && /^VH-\d+$/i.test(ref) ? [{ kind: 'issue', ref }] : [],
            });
        }
        case 'todo_add':
        case 'todo_complete': {
            const added = /^added todo (\S+) "(.*)" v(\d+)/.exec(text ?? '');
            const completed = /^todo (\S+) is (\S+) v(\d+)/.exec(text ?? '');
            return v('todo', name === 'todo_add' ? 'done' : completed?.[2] === 'done' ? 'done' : 'updated', {
                heading: added?.[2] ?? str(input.title),
                fields: [...field('key', added?.[1] ?? completed?.[1] ?? input.id, true), ...field('version', added?.[3] ?? completed?.[3])],
                preview: str(input.note),
            });
        }
        case 'project_note': {
            const seq = /recorded #(\d+)/.exec(text ?? '')?.[1];
            const refused = json?.ok === false;
            return v('note', refused ? 'failed' : 'recorded', {
                heading: str(input.title),
                fields: [...field('kind', input.kind), ...(seq ? [{ key: 'key' as const, value: `#${seq}`, mono: true }] : []), ...field('project', input.projectId, true)],
                preview: str(input.body),
                ...(refused ? { errorCode: str(json?.error), errorText: str(json?.detail) } : {}),
            });
        }
        case 'owner_board_post':
        case 'owner_board_update':
        case 'owner_board_resolve': {
            const item = json?.item && typeof json.item === 'object' ? json.item as Rec : null;
            const options = Array.isArray(input.options) ? input.options.map((o) => (o && typeof o === 'object' ? str((o as Rec).label) : str(o))).filter((o): o is string => !!o) : undefined;
            const status: ToolStatus = name === 'owner_board_resolve' ? 'resolved' : name === 'owner_board_update' ? 'updated' : 'posted';
            return v('board', status, {
                heading: str(input.title) ?? str(item?.title),
                fields: [...field('kind', input.kind ?? item?.kind), ...field('outcome', input.outcome)],
                preview: str(input.body_md) ?? str(input.append_md) ?? str(input.note),
                items: options?.length ? options : undefined,
                links: [{ kind: 'board' }],
            });
        }
        case 'session_wrapup': {
            const state = str(json?.state);
            return v('lifecycle', state === 'running' ? 'in-progress' : 'queued', {
                fields: field('session', json?.sessionId ?? input.sessionId, true),
                links: sessionLink(json?.sessionId ?? input.sessionId, 'target'),
                ...(json?.deduped === true || json?.already === true ? { status: 'already' as const } : {}),
            });
        }
        case 'session_handoff': {
            const to = str(json?.to) ?? str(input.to) ?? 'new';
            const fresh = to === 'new' || to === 'fresh';
            const state = str(json?.state);
            return v('lifecycle', json?.deduped === true || json?.already === true ? 'already' : state === 'done' ? 'done' : state === 'running' ? 'in-progress' : 'queued', {
                fields: [...field('from', json?.from ?? input.from, true), ...(fresh ? [{ key: 'to' as const, value: 'new' }] : field('to', to, true))],
                preview: str(input.note),
                links: [...sessionLink(json?.from ?? input.from, 'from'), ...(fresh ? [] : sessionLink(to, 'to'))],
            });
        }
        case 'session_restart': {
            const scheduled = str(json?.scheduled) ?? str(input.when) ?? 'idle';
            return v('lifecycle', json?.already === true || json?.deduped === true ? 'already' : scheduled === 'now' ? 'scheduled-now' : 'scheduled-idle', {
                fields: [...field('session', json?.sessionId ?? input.sessionId, true), ...field('version', json?.targetVersion, true)],
                links: sessionLink(json?.sessionId ?? input.sessionId, 'target'),
            });
        }
        case 'automation_create':
        case 'automation_update':
            return v('session', name === 'automation_create' ? 'done' : 'updated', { heading: str(input.name) ?? str(input.title), preview: firstLine(text) });
        case 'owner_board_list': {
            const items = Array.isArray(json?.items) ? (json!.items as unknown[]) : null;
            if (items) {
                const rows = items.map((it) => (it && typeof it === 'object' ? [str((it as Rec).title), str((it as Rec).state)].filter(Boolean).join(' · ') : '')).filter(Boolean);
                return listView(v, rows, { links: [{ kind: 'board' }], count: rows.length });
            }
            return listView(v, lines(text), { links: [{ kind: 'board' }] });
        }
        case 'teams_list':
        case 'issue_list':
        case 'todo_list':
        case 'project_list':
        case 'project_context':
        case 'sessions_list':
        case 'terminals_list':
        case 'session_peers': {
            if (name === 'session_peers' && json && Array.isArray(json.sessions)) {
                const rows = (json.sessions as unknown[]).map((s) => (s && typeof s === 'object' ? [str((s as Rec).title), str((s as Rec).sessionId)].filter(Boolean).join(' · ') : '')).filter(Boolean);
                return listView(v, rows, { count: rows.length });
            }
            const all = lines(text);
            // first line of the CLI's list answers is a header ("3 team(s) — id name …:")
            const header = all.length > 1 && /:\s*$/.test(all[0]) ? all[0] : null;
            const rows = (header ? all.slice(1) : all).filter((l) => !/^\(more:|^\[truncated/.test(l));
            const empty = all.length === 1 && /^no |^No /.test(all[0]);
            return listView(v, empty ? [] : rows, { header: header ?? undefined, count: num(json?.count) ?? (empty ? 0 : rows.length) });
        }
    }
    return v('session', 'done', { preview: firstLine(text) });
}

function listView(v: (kind: ToolCardKind, status: ToolStatus, rest?: Partial<ToolCardView>) => ToolCardView, rows: string[], opts: { header?: string; links?: ToolLink[]; count?: number }): ToolCardView {
    const shown = rows.slice(0, LIST_SHOWN);
    return v('list', 'done', {
        heading: String(opts.count ?? rows.length),
        items: shown,
        more: rows.length > shown.length ? rows.length - shown.length : undefined,
        links: opts.links ?? [],
    });
}

function firstLine(text: string | null): string | undefined {
    const l = lines(text)[0];
    return l ? l : undefined;
}

/** `formatIssueLine`: `VH-12  [todo]  Title  (unassigned · high)` (CLI issues/format.ts), optionally after a verb. */
export function parseIssueLine(text: string | null): { key: string; status: string; title: string } | null {
    const m = /(VH-\d+)\s+\[([a-z_]+)\]\s+(.+?)\s+\([^)]*\)(?:;.*)?$/m.exec(text ?? '');
    return m ? { key: m[1], status: m[2], title: m[3] } : null;
}
