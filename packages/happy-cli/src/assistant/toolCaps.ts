/**
 * B-916b: output caps for the main agent's tool surface.
 *
 * The main agent (assistant variant, outside any team scope) is a long-lived
 * dispatcher: every tool answer stays in its context for hours. B-909 found a
 * lead whose team_* answers ran to 438k characters (median) and spilled to
 * disk 1349 times in 30 days. So on this surface every answer has a ceiling:
 *
 *  - receipt (writes and every error): ≤ 400 characters;
 *  - list: ≤ 4,000 characters, one line ≤ 160;
 *  - body (a transcript, a terminal screen, one object in full): ≤ 8,000.
 *
 * A list or body that does not fit is cut at a line break and ends with a
 * notice naming the `cursor` to pass for the rest; the wrapper adds that
 * optional `cursor` argument to every pageable tool. A receipt that does not
 * fit keeps its identifying fields (ok / id / key / status / …) and says so.
 *
 * Applied by wrapping the registrar (`withToolOutputCaps`), so the same tool
 * implementations keep their answers unchanged for every other session (a
 * team lead's team_inspect, a worker's automation_get). The server side of
 * the same idea (old wrappers) is B-911, not this file.
 */

import { z } from 'zod'
import type { AssistantToolRegistrar } from './assistantTools'

export const RECEIPT_MAX_CHARS = 400
export const LIST_MAX_CHARS = 4_000
export const LIST_LINE_MAX_CHARS = 160
export const BODY_MAX_CHARS = 8_000

export type CapClass = 'receipt' | 'list' | 'body'

type ToolText = { type: 'text'; text: string }
type ToolResultLike = { content?: Array<{ type: string; text?: string } & Record<string, unknown>>; isError?: boolean } & Record<string, unknown>

/** Never split a UTF-16 surrogate pair (an emoji cut in half renders as U+FFFD). */
function safeCut(text: string, end: number): number {
    if (end <= 0) return 0
    if (end >= text.length) return text.length
    const code = text.charCodeAt(end - 1)
    return code >= 0xd800 && code <= 0xdbff ? end - 1 : end
}

function clipLine(line: string, max: number): string {
    return line.length > max ? `${line.slice(0, safeCut(line, max - 1))}…` : line
}

/** Plain text receipt: cut to the limit with a visible marker. */
export function capReceiptText(text: string, max = RECEIPT_MAX_CHARS): string {
    if (text.length <= max) return text
    const marker = ' …[truncated]'
    return `${text.slice(0, safeCut(text, max - marker.length))}${marker}`
}

const RECEIPT_KEYS = [
    'ok', 'error', 'id', 'key', 'seq', 'name', 'title', 'status', 'state', 'outcome', 'created', 'deleted', 'version',
    'taskId', 'attemptId', 'currentAttemptId', 'goalVersion', 'scheduleId', 'sessionId', 'runId', 'nextRunAt',
    'scheduled', 'targetVersion', 'url', 'delivered', 'queued',
    // B-916c gate 2 receipts (dispatch_approved needs approvalId / boardItemId).
    'approvalId', 'boardItemId', 'risk', 'choice', 'result', 'note',
] as const
const RECEIPT_KEY_SET = new Set<string>(RECEIPT_KEYS)

function isScalar(value: unknown): value is string | number | boolean | null {
    return value === null || ['string', 'number', 'boolean'].includes(typeof value)
}

function pickReceiptFields(value: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    for (const key of RECEIPT_KEYS) {
        const v = value[key]
        if (v !== undefined && isScalar(v)) out[key] = typeof v === 'string' ? clipLine(v, 120) : v
    }
    return out
}

/**
 * A JSON answer of a write tool → its identifying fields: whitelisted scalars
 * of the top level, plus the same of each nested object one level down
 * (`{automation:{…}}`, `{run:{…}}`, a team receipt's `task`). Anything else
 * (full objects, team summaries, hints) is left out — the receipt says
 * where the detail is instead.
 */
export function jsonReceipt(value: unknown, max = RECEIPT_MAX_CHARS): string {
    // A receipt that already fits is passed through as written (B-916c gate receipts, tool-shaped answers).
    const whole = JSON.stringify(value)
    if (whole !== undefined && whole.length <= max) return whole
    if (!value || typeof value !== 'object' || Array.isArray(value)) return capReceiptText(JSON.stringify(value), max)
    const record = value as Record<string, unknown>
    const out = pickReceiptFields(record)
    for (const [key, child] of Object.entries(record)) {
        if (RECEIPT_KEY_SET.has(key) || !child || typeof child !== 'object' || Array.isArray(child)) continue
        const picked = pickReceiptFields(child as Record<string, unknown>)
        if (Object.keys(picked).length) out[key] = picked
    }
    if (out.ok === undefined) out.ok = true
    let text = JSON.stringify(out)
    if (text.length <= max) return text
    // Still too long: drop nested objects, keep the top-level identity.
    const flat = Object.fromEntries(Object.entries(out).filter(([, v]) => isScalar(v)))
    text = JSON.stringify({ ...flat, truncated: true })
    return capReceiptText(text, max)
}

/** `cursor` is a character offset into the full answer, as a decimal string. */
export function parseCursor(cursor: unknown): number {
    if (typeof cursor !== 'string' || !/^(0|[1-9][0-9]{0,8})$/.test(cursor)) return 0
    return Number(cursor)
}

/**
 * One page of a long answer. Lists clip each line to 160 characters first.
 * The page is cut at the last line break that keeps it within `max`
 * (including the notice); a single overlong line is cut mid-line.
 */
export function pageText(text: string, cls: 'list' | 'body', cursor?: unknown): string {
    const max = cls === 'list' ? LIST_MAX_CHARS : BODY_MAX_CHARS
    const full = cls === 'list' ? text.split('\n').map(line => clipLine(line, LIST_LINE_MAX_CHARS)).join('\n') : text
    const start = Math.min(parseCursor(cursor), full.length)
    const prefix = start > 0 ? `[continued from cursor="${start}"]\n` : ''
    const rest = full.slice(start)
    if (prefix.length + rest.length <= max) return `${prefix}${rest}`
    // Reserve room for the notice (its digits are bounded by the text length).
    const notice = (end: number) => `\n[truncated: characters ${start}–${end} of ${full.length} shown; call again with cursor="${end}" for the rest]`
    const budget = max - prefix.length - notice(full.length).length
    let cut = safeCut(rest, budget)
    const lineBreak = rest.lastIndexOf('\n', cut - 1)
    if (lineBreak > budget / 2) cut = lineBreak + 1
    const end = start + cut
    return `${prefix}${rest.slice(0, cut)}${notice(end)}`
}

export type CapRule = CapClass | ((args: Record<string, unknown>) => CapClass)

/**
 * Which ceiling each tool of the main agent's surface gets. Tools not named
 * here fall back by shape: `*_list` / `*s_list` → list, otherwise body for
 * read-only tools and receipt for writes (see `capClassFor`).
 */
export const MAIN_AGENT_CAP_RULES: Record<string, CapRule> = {
    // B-051 assistant tools
    sessions_list: 'list', session_read: 'body', session_send: 'receipt', session_spawn: 'receipt',
    session_kill: 'receipt', session_archive: 'receipt',
    terminals_list: 'list', terminal_read: 'body', terminal_send: 'receipt',
    memory_update: 'receipt', journal_append: 'receipt',
    // automations
    automation_list: 'list', automation_runs: 'list', automation_get: 'body',
    // teams
    team_inspect: (args) => (args.taskId || args.full ? 'body' : 'list'),
    teams_list: 'list',
    // board / issues / todos / projects
    owner_board_list: 'list', issue_list: 'list', issue_get: 'body', todo_list: 'list',
    project_list: 'list', project_context: 'body',
    // B-924
    boards_read: 'list', sessions_search: 'list', wrapup_suggest: 'receipt', wrapup_selected: 'receipt',
}

export function capClassFor(name: string, args: Record<string, unknown>, readOnly: boolean): CapClass {
    const rule = MAIN_AGENT_CAP_RULES[name]
    if (rule) return typeof rule === 'function' ? rule(args) : rule
    if (/_list$|s_list$/.test(name)) return 'list'
    return readOnly ? 'body' : 'receipt'
}

function textOf(result: ToolResultLike): string {
    return (result.content ?? []).filter(c => c.type === 'text' && typeof c.text === 'string').map(c => c.text as string).join('\n')
}

function tryJson(text: string): unknown {
    const trimmed = text.trim()
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return undefined
    try { return JSON.parse(trimmed) } catch { return undefined }
}

/** Optional per-tool line views for JSON list answers (see `withToolOutputCaps`). */
export type ListFormatter = (value: unknown) => string | null

/** Cap one tool result. Non-text content (none of ours have it) passes through. */
export function capToolResult(
    result: ToolResultLike,
    cls: CapClass,
    cursor?: unknown,
    format?: ListFormatter,
): { content: ToolText[]; isError: boolean } {
    const isError = result.isError === true
    const text = textOf(result)
    if (isError) return { content: [{ type: 'text', text: capReceiptText(text) }], isError: true }
    if (cls === 'receipt') {
        const json = tryJson(text)
        return { content: [{ type: 'text', text: json === undefined ? capReceiptText(text) : jsonReceipt(json) }], isError: false }
    }
    let body = text
    if (cls === 'list') {
        // A JSON list answer is one long line: give it lines (a one-line view per item
        // when the tool has one, else indented JSON) so the 160-character line clip
        // and the whole-line page cut apply to its entries, not to the answer.
        const json = tryJson(text)
        const lines = json === undefined ? null : format?.(json) ?? null
        if (lines !== null) body = lines
        else if (json !== undefined) body = JSON.stringify(json, null, 1)
    }
    return { content: [{ type: 'text', text: pageText(body, cls, cursor) }], isError: false }
}

const CURSOR_DESCRIPTION = 'Continue a truncated answer: pass the cursor named in its "[truncated: … cursor=…]" line'
const WRAPPED = Symbol.for('vh.toolCaps.wrapped')

/**
 * Wrap a registrar so every tool registered through it answers within the
 * main agent's ceilings. Pageable tools (list / body, or whose class depends
 * on the arguments) get an optional `cursor` argument; it is removed before
 * the tool's own handler runs. Wrapping twice is a no-op.
 */
export function withToolOutputCaps(inner: AssistantToolRegistrar, formatters: Record<string, ListFormatter> = {}): AssistantToolRegistrar {
    if ((inner as any)[WRAPPED]) return inner
    const wrapped = {
        [WRAPPED]: true,
        registerTool(name: string, config: any, handler: (...a: any[]) => any) {
            const rule = MAIN_AGENT_CAP_RULES[name]
            const readOnly = config?.annotations?.readOnlyHint === true
            const pageable = typeof rule === 'function' || capClassFor(name, {}, readOnly) !== 'receipt'
            const schema = config?.inputSchema
            const addCursor = pageable && schema && typeof schema === 'object' && !('cursor' in schema)
            const nextConfig = addCursor ? { ...config, inputSchema: { ...schema, cursor: z.string().max(16).optional().describe(CURSOR_DESCRIPTION) } } : config
            return (inner.registerTool as any)(name, nextConfig, async (args: any, extra: any) => {
                const input = args && typeof args === 'object' ? { ...args } : {}
                const cursor = addCursor ? input.cursor : undefined
                if (addCursor) delete input.cursor
                let result: ToolResultLike
                try { result = await handler(input, extra) }
                catch (error) { result = { content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true } }
                return capToolResult(result, capClassFor(name, input, readOnly), cursor, formatters[name])
            })
        },
    }
    return wrapped as unknown as AssistantToolRegistrar
}
