/**
 * Main agent gate 2 — dispatch gate (B-916c, spec §4.2).
 *
 * `gateRegistrar(mcp, gate)` wraps the MCP registrar of a main-agent session:
 * every dispatch tool (one that hands text to another executor) gains a
 * required `risk` argument and is intercepted. `risk` = none (after the
 * keyword + haiku re-check) runs the tool; anything else parks the call in
 * `pending-dispatch/<approvalId>.json` and posts a briefing-board decision
 * card. `dispatch_approved(approvalId)` later runs the parked call, but only
 * when the OWNER chose approve / draft on that card and the stored arguments
 * still hash the same. Tool implementations never see `risk`.
 *
 * Fails closed: no board, no pending file, a card closed by anyone but the
 * owner, a hash mismatch — nothing is dispatched.
 */

import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { AssistantToolRegistrar } from '../assistantTools'
import { effectiveRisk, isRiskLevel, RISK_LEVELS, type OneShotRunner, type RiskLevel } from './risk'

/** Dispatch tools and the argument text each hands over (spec §4.2 table). */
export const DISPATCH_TOOL_PAYLOADS: Readonly<Record<string, (args: Record<string, unknown>) => string>> = {
    session_spawn: (a) => str(a.prompt),
    session_send: (a) => str(a.text) || str(a.message),
    terminal_send: (a) => str(a.text) || str(a.input),
    team_delegate: (a) => delegatePayload(a),
    team_message: (a) => str(a.body),
    lead_delegate: (a) => delegatePayload(a),
    lead_message: (a) => str(a.body),
    session_message: (a) => str(a.body),
    automation_create: (a) => automationPayload(a.action),
    automation_update: (a) => automationPayload(a.action),
}
export const DISPATCH_TOOL_NAMES = Object.keys(DISPATCH_TOOL_PAYLOADS)

/** Which argument receives the approval prefix when a parked call runs. */
const PAYLOAD_FIELD: Readonly<Record<string, string>> = {
    session_spawn: 'prompt', session_send: 'text', terminal_send: 'text', team_delegate: 'goal',
    team_message: 'body', session_message: 'body', lead_delegate: 'goal', lead_message: 'body',
}

export const DISPATCH_APPROVED_TOOL = 'dispatch_approved'
export const DISPATCH_CARD_KEY_PREFIX = 'main-agent-dispatch:'
export const RECEIPT_MAX_CHARS = 400

function str(value: unknown): string { return typeof value === 'string' ? value : '' }
function delegatePayload(a: Record<string, unknown>): string {
    return [str(a.goal), ...(Array.isArray(a.acceptance) ? a.acceptance.map(str) : [])].filter(Boolean).join('\n')
}
function automationPayload(action: unknown): string {
    if (!action || typeof action !== 'object') return ''
    const a = action as Record<string, unknown>
    if (typeof a.prompt === 'string') return a.prompt
    if (Array.isArray(a.argv)) return a.argv.map(String).join(' ')
    return JSON.stringify(a).slice(0, 2_000)
}

export function canonicalArgsHash(toolName: string, args: Record<string, unknown>): string {
    const sort = (value: unknown): unknown => Array.isArray(value) ? value.map(sort)
        : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value as object).sort().map(k => [k, sort((value as Record<string, unknown>)[k])]))
        : value
    return createHash('sha256').update(JSON.stringify([toolName, sort(args)])).digest('hex')
}

export function receipt(value: Record<string, unknown>): string {
    const text = JSON.stringify(value)
    if (text.length <= RECEIPT_MAX_CHARS) return text
    const { error, ...rest } = value
    const clipped = JSON.stringify({ ...rest, ...(typeof error === 'string' ? { error: error.slice(0, 120) } : {}) })
    return clipped.length <= RECEIPT_MAX_CHARS ? clipped : clipped.slice(0, RECEIPT_MAX_CHARS - 1) + '…'
}

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError: boolean }
const ok = (value: Record<string, unknown>): ToolResult => ({ content: [{ type: 'text', text: receipt(value) }], isError: false })
const fail = (value: Record<string, unknown>): ToolResult => ({ content: [{ type: 'text', text: receipt({ ok: false, ...value }) }], isError: true })

export type BoardItemView = { id: string; key: string | null; state: string; ownerChoice: string | null; resolvedBy: string | null }

export type DispatchBoard = {
    /** Post (upsert by key) the decision card; resolves to the item id. Throws when the board is unavailable. */
    postDecision(card: { key: string; title: string; bodyMd: string; requestId: string }): Promise<{ id: string }>
    /** Find the card by key among this session's items (any state). Null = not found. Throws when unavailable. */
    findByKey(key: string): Promise<BoardItemView | null>
}

export type PendingDispatch = {
    v: 1
    approvalId: string
    toolName: string
    args: Record<string, unknown>
    argsSha256: string
    declared: RiskLevel
    level: RiskLevel
    boardItemId?: string
    createdAt: number
    result?: string
}

export type DispatchGateDeps = {
    /** `~/.happy/assistant/pending-dispatch` */
    pendingDir: string
    board: DispatchBoard | null
    /** haiku one-shot; null disables the classifier (tests, no claude binary). */
    classify: OneShotRunner | null
    /** Link to the card for the dispatched prompt: `<web>/session/<id>?panel=board`. */
    approvalLink: (boardItemId: string) => string
    now?: () => number
    newId?: () => string
    log?: (line: string) => void
}

type Handler = (args: any, extra?: any) => Promise<ToolResult> | ToolResult

function firstLine(text: string, max: number): string {
    const line = (text.split('\n').find(l => l.trim()) ?? '').trim().replace(/\s+/g, ' ')
    return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/** Clip a string to a UTF-8 byte budget. */
function clipBytes(text: string, bytes: number): string {
    const enc = new TextEncoder()
    if (enc.encode(text).length <= bytes) return text
    let out = text.slice(0, bytes)
    while (enc.encode(out).length > bytes - 3) out = out.slice(0, -1)
    return out + '…'
}

export function decisionCard(pending: Pick<PendingDispatch, 'approvalId' | 'toolName' | 'declared' | 'level'>, payload: string) {
    const head = firstLine(payload, 60) || pending.toolName
    return {
        key: `${DISPATCH_CARD_KEY_PREFIX}${pending.approvalId}`,
        title: `主 agent 想派活（${pending.level}）：${head}`.slice(0, 120),
        bodyMd: clipBytes([
            `工具：${pending.toolName}`,
            `风险：${pending.level}（声明 ${pending.declared}${pending.declared === pending.level ? '' : `，复核 ${pending.level}`}）`,
            `批准号：${pending.approvalId}`,
            '',
            '内容：',
            payload.slice(0, 1_500),
        ].join('\n'), 7_900),
        requestId: `dispatch-${pending.approvalId}`,
    }
}

export const DISPATCH_OPTIONS = [
    { id: 'approve', label: '批准执行' },
    { id: 'draft', label: '只出草稿', recommended: true },
    { id: 'drop', label: '放弃' },
] as const

/** Prefix the approved call's payload; drafts get the do-not-send variant. */
export function withApprovalPrefix(toolName: string, args: Record<string, unknown>, link: string, choice: 'approve' | 'draft'): Record<string, unknown> {
    const line = choice === 'approve' ? `本任务已获批：${link}` : `本任务已获批，但只出草稿、不得发送或发布：${link}`
    const field = PAYLOAD_FIELD[toolName]
    if (field) return { ...args, [field]: `${line}\n\n${str(args[field])}` }
    if ((toolName === 'automation_create' || toolName === 'automation_update') && args.action && typeof args.action === 'object' && typeof (args.action as any).prompt === 'string') {
        return { ...args, action: { ...(args.action as object), prompt: `${line}\n\n${(args.action as any).prompt}` } }
    }
    return args
}

async function writePrivate(path: string, value: unknown): Promise<void> {
    const tmp = `${path}.${randomUUID()}.tmp`
    await writeFile(tmp, JSON.stringify(value), { mode: 0o600 })
    await rename(tmp, path)
}

const APPROVAL_ID_RE = /^[0-9a-f-]{36}$/i

export function createDispatchGate(deps: DispatchGateDeps) {
    const now = deps.now ?? Date.now
    const newId = deps.newId ?? randomUUID
    const handlers = new Map<string, Handler>()
    const pendingPath = (id: string) => join(deps.pendingDir, `${id}.json`)
    const donePath = (id: string) => join(deps.pendingDir, `${id}.done.json`)

    async function readJson(path: string): Promise<PendingDispatch | null> {
        try { return JSON.parse(await readFile(path, 'utf8')) as PendingDispatch } catch { return null }
    }

    /** Intercept one dispatch-tool call. */
    async function intercept(toolName: string, rawArgs: Record<string, unknown>, extra: unknown): Promise<ToolResult> {
        const { risk, ...args } = rawArgs ?? {}
        if (!isRiskLevel(risk)) return fail({ error: 'risk_required', hint: `pass risk: ${RISK_LEVELS.join(' | ')}` })
        const payload = DISPATCH_TOOL_PAYLOADS[toolName]?.(args) ?? ''
        const { level, keyword, classifier } = await effectiveRisk({ toolName, declared: risk, payload, classify: deps.classify })
        deps.log?.(`[main-agent gate] ${toolName} declared=${risk} keyword=${keyword} classifier=${classifier ?? 'n/a'} → ${level}`)
        if (level === 'none') return handlers.get(toolName)!(args, extra)
        if (!deps.board) return fail({ error: 'board_unavailable', risk: level })
        const approvalId = newId()
        const pending: PendingDispatch = { v: 1, approvalId, toolName, args, argsSha256: canonicalArgsHash(toolName, args), declared: risk, level, createdAt: now() }
        try {
            await mkdir(deps.pendingDir, { recursive: true, mode: 0o700 })
            await writePrivate(pendingPath(approvalId), pending)
            const card = decisionCard(pending, payload)
            const { id } = await deps.board.postDecision(card)
            await writePrivate(pendingPath(approvalId), { ...pending, boardItemId: id })
            return ok({ ok: true, state: 'awaiting_decision', approvalId, boardItemId: id, risk: level, note: '已放到「需要我决策」，等用户选择后调 dispatch_approved' })
        } catch (error) {
            deps.log?.(`[main-agent gate] park failed: ${error instanceof Error ? error.message : String(error)}`)
            return fail({ error: 'board_unavailable', risk: level })
        }
    }

    async function approved(args: { approvalId?: unknown }): Promise<ToolResult> {
        const approvalId = typeof args?.approvalId === 'string' ? args.approvalId : ''
        if (!APPROVAL_ID_RE.test(approvalId)) return fail({ error: 'approval_not_found' })
        const done = await readJson(donePath(approvalId))
        if (done?.result) return ok({ ok: true, state: 'already_dispatched', approvalId, result: done.result.slice(0, 200) })
        const pending = await readJson(pendingPath(approvalId))
        if (!pending || pending.approvalId !== approvalId) return fail({ error: 'approval_not_found' })
        if (!deps.board) return fail({ error: 'board_unavailable' })
        let item: BoardItemView | null
        try { item = await deps.board.findByKey(`${DISPATCH_CARD_KEY_PREFIX}${approvalId}`) } catch { return fail({ error: 'board_unavailable' }) }
        if (!item || (pending.boardItemId && item.id !== pending.boardItemId)) return fail({ error: 'approval_not_found' })
        if (item.state === 'open' || item.state === 'in_progress') return fail({ error: 'awaiting_decision', boardItemId: item.id })
        if (item.resolvedBy !== 'owner') return fail({ error: 'not_approved', boardItemId: item.id })
        if (item.ownerChoice === 'drop') {
            await writePrivate(donePath(approvalId), { ...pending, result: 'dropped' })
            return ok({ ok: true, state: 'dropped', approvalId })
        }
        if (item.ownerChoice !== 'approve' && item.ownerChoice !== 'draft') return fail({ error: 'not_approved', boardItemId: item.id })
        if (canonicalArgsHash(pending.toolName, pending.args) !== pending.argsSha256) return fail({ error: 'approval_mismatch' })
        const handler = handlers.get(pending.toolName)
        if (!handler) return fail({ error: 'tool_unavailable', tool: pending.toolName })
        const result = await handler(withApprovalPrefix(pending.toolName, pending.args, deps.approvalLink(item.id), item.ownerChoice), undefined)
        const text = result.content.map(c => c.text).join('\n')
        if (!result.isError) await writePrivate(donePath(approvalId), { ...pending, result: text.slice(0, 1_000) })
        return { content: [{ type: 'text', text: receipt({ ok: !result.isError, state: result.isError ? 'dispatch_failed' : 'dispatched', approvalId, choice: item.ownerChoice, result: text.slice(0, 200) }) }], isError: result.isError }
    }

    return {
        /** Wrap a registrar: dispatch tools gain `risk` and are intercepted; everything else passes through. */
        wrap(mcp: AssistantToolRegistrar): AssistantToolRegistrar {
            const registerTool = ((name: string, config: any, handler: Handler) => {
                if (!(name in DISPATCH_TOOL_PAYLOADS)) return (mcp.registerTool as any)(name, config, handler)
                handlers.set(name, handler)
                const riskSchema = z.enum(RISK_LEVELS).describe('Required. none = stays inside Very Happy / this machine; external = the result is sent or published where other people see it (messages, mail, comments, PRs, pushes, shares); production = writes production data or infrastructure. Non-none goes to the owner\'s decision board first.')
                const description = `${config?.description ?? ''} [Main agent: pass risk; external/production calls are parked on the decision board and run only via dispatch_approved after the owner approves.]`
                return (mcp.registerTool as any)(name, { ...config, description, inputSchema: { ...(config?.inputSchema ?? {}), risk: riskSchema } }, (args: Record<string, unknown>, extra: unknown) => intercept(name, args, extra))
            }) as AssistantToolRegistrar['registerTool']
            return { registerTool }
        },
        /** Register `dispatch_approved` on the real server. */
        registerApprovedTool(mcp: AssistantToolRegistrar): void {
            (mcp.registerTool as any)(DISPATCH_APPROVED_TOOL, {
                description: 'Run a dispatch the owner approved on the decision board. Pass the approvalId from the awaiting_decision receipt. Runs only when the owner chose 批准执行 (approve) or 只出草稿 (draft; the prompt then forbids sending). Idempotent: a second call returns the first result.',
                title: 'Run Approved Dispatch',
                inputSchema: { approvalId: z.string().min(1).max(64) },
            }, (args: { approvalId?: unknown }) => approved(args))
        },
        /** Test hook. */
        _intercept: intercept,
        _approved: approved,
    }
}
export type DispatchGate = ReturnType<typeof createDispatchGate>
