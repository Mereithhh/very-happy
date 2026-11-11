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
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { approvalClaims, cardFaceHash, clipBytes, DISPATCH_CARD_KEY_PREFIX, isReservedCardKey, ownerDecision, writePrivateJson as writePrivate, type BoardItemView } from '@/attention/ownerApproval'
import type { AssistantToolRegistrar } from '../assistantTools'
import type { DispatchPolicy } from '@slopus/happy-wire'
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
const BOARD_WRITE_TOOLS = new Set(['owner_board_post', 'owner_board_update', 'owner_board_resolve'])

// The card face, owner check and single-use claim are shared with `very-happy settings` (attention/ownerApproval.ts).
export { cardFaceHash, DISPATCH_CARD_KEY_PREFIX, isReservedCardKey, type BoardItemView }
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

export type DispatchBoard = {
    /** Post (upsert by key) the decision card; resolves to the item id. Throws when the board is unavailable. Default options = DISPATCH_OPTIONS. */
    postDecision(card: { key: string; title: string; bodyMd: string; requestId: string; options?: ReadonlyArray<{ id: string; label: string; recommended?: boolean }> }): Promise<BoardItemView>
    /** Find the card by key among this session's items (any state). Null = not found. Throws when unavailable. */
    findByKey(key: string): Promise<BoardItemView | null>
    /** The card with this id among this session's items (any state). Null = not found. Throws when unavailable. */
    findById(id: string): Promise<BoardItemView | null>
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
    /** cardFaceHash of the card as posted (QA77 P1). */
    cardSha256?: string
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
    /** B-922: what each non-none level does (default: ask for both = B-916c). Read per call. */
    dispatchPolicy?: () => { external: DispatchPolicy; production: DispatchPolicy }
    /**
     * Force the decision card whatever the risk (and whatever the dispatch policy). One hook for every such
     * rule: setup.ts ORs the conditions (B-922: terminal_send while Bash is off). Args are the call's (no risk).
     */
    mustAsk?: (toolName: string, args: Record<string, unknown>) => boolean
}

type Handler = (args: any, extra?: any) => Promise<ToolResult> | ToolResult

function firstLine(text: string, max: number): string {
    const line = (text.split('\n').find(l => l.trim()) ?? '').trim().replace(/\s+/g, ' ')
    return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

export function decisionCard(pending: Pick<PendingDispatch, 'approvalId' | 'toolName' | 'declared' | 'level'>, payload: string, forced = false) {
    const head = firstLine(payload, 60) || pending.toolName
    return {
        key: `${DISPATCH_CARD_KEY_PREFIX}${pending.approvalId}`,
        title: `主 agent 想派活（${pending.level}）：${head}`.slice(0, 120),
        bodyMd: clipBytes([
            `工具：${pending.toolName}`,
            `风险：${pending.level}（声明 ${pending.declared}${pending.declared === pending.level ? '' : `，复核 ${pending.level}`}）`,
            `批准号：${pending.approvalId}`,
            ...(forced ? [pending.toolName === 'terminal_send'
                ? '原因：主 agent 的 Bash 已关闭，往终端里发内容等于直接执行命令，所以每次都先问你。'
                // B-924: the other forced case (sendGuard.ts) — a send to another session in a turn the owner did not type.
                : '原因：这一回合不是你本人发起的（自动化、脚本或别的会话发来的消息），主 agent 给别的会话发消息都先问你。'] : []),
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
        const forced = deps.mustAsk?.(toolName, args) === true
        if (level === 'none' && !forced) return handlers.get(toolName)!(args, extra)
        // B-922: the owner chose "直接派" for this level (default ask = B-916c).
        const policy = deps.dispatchPolicy?.()
        if (!forced && level !== 'none' && policy && policy[level] === 'direct') {
            deps.log?.(`[main-agent gate] ${toolName} ${level} dispatched directly (owner setting)`)
            return handlers.get(toolName)!(args, extra)
        }
        if (!deps.board) return fail({ error: 'board_unavailable', risk: level })
        const approvalId = newId()
        const pending: PendingDispatch = { v: 1, approvalId, toolName, args, argsSha256: canonicalArgsHash(toolName, args), declared: risk, level, createdAt: now() }
        try {
            await mkdir(deps.pendingDir, { recursive: true, mode: 0o700 })
            await writePrivate(pendingPath(approvalId), pending)
            const card = decisionCard(pending, payload, forced)
            const posted = await deps.board.postDecision(card)
            const id = posted.id
            await writePrivate(pendingPath(approvalId), { ...pending, boardItemId: id, cardSha256: cardFaceHash(posted) })
            return ok({ ok: true, state: 'awaiting_decision', approvalId, boardItemId: id, risk: level, note: '已放到「需要我决策」，等用户选择后调 dispatch_approved' })
        } catch (error) {
            deps.log?.(`[main-agent gate] park failed: ${error instanceof Error ? error.message : String(error)}`)
            return fail({ error: 'board_unavailable', risk: level })
        }
    }

    async function approved(args: { approvalId?: unknown; boardItemId?: unknown }): Promise<ToolResult> {
        // QA80 P3: after a new conversation / compaction the main agent may only hold the card id.
        // Resolve it to the approval through the gate's own pending records; every check below is unchanged.
        let approvalId = typeof args?.approvalId === 'string' ? args.approvalId : ''
        if (!approvalId && typeof args?.boardItemId === 'string' && args.boardItemId) approvalId = (await approvalIdForCard(args.boardItemId)) ?? ''
        if (!APPROVAL_ID_RE.test(approvalId)) return fail({ error: 'approval_not_found' })
        const done = await readJson(donePath(approvalId))
        if (done?.result) return ok({ ok: true, state: 'already_dispatched', approvalId, result: done.result.slice(0, 200) })
        const pending = await readJson(pendingPath(approvalId))
        if (!pending || pending.approvalId !== approvalId) return fail({ error: 'approval_not_found' })
        // QA77 #3: no card was ever posted (or its face was never recorded) → nothing the owner could have approved.
        if (!pending.boardItemId || !pending.cardSha256) return fail({ error: 'approval_not_found' })
        if (!deps.board) return fail({ error: 'board_unavailable' })
        let item: BoardItemView | null
        try { item = await deps.board.findById(pending.boardItemId) } catch { return fail({ error: 'board_unavailable' }) }
        const decision = ownerDecision(item, { key: `${DISPATCH_CARD_KEY_PREFIX}${approvalId}`, cardSha256: pending.cardSha256 })
        if (!decision.ok) return fail({ error: decision.error, ...(decision.boardItemId ? { boardItemId: decision.boardItemId } : {}) })
        item = decision.item
        if (canonicalArgsHash(pending.toolName, pending.args) !== pending.argsSha256) return fail({ error: 'approval_mismatch' })
        // QA77 #4: one dispatch per approvalId, even under concurrent calls (O_EXCL marker; rolled back on failure).
        const claimed = await claim(approvalId)
        if (!claimed) return ok({ ok: true, state: 'already_dispatched', approvalId })
        try {
            if (item.ownerChoice === 'drop') {
                await writePrivate(donePath(approvalId), { ...pending, result: 'dropped' })
                return ok({ ok: true, state: 'dropped', approvalId })
            }
            if (item.ownerChoice === 'draft') {
                // 只出草稿: nothing is handed to another executor; the main agent writes the draft in chat.
                await writePrivate(donePath(approvalId), { ...pending, result: 'draft_only' })
                return ok({ ok: true, state: 'draft_only', approvalId, note: '用户选了只出草稿：不派会话，在对话里给出草稿' })
            }
            if (item.ownerChoice !== 'approve') { await release(approvalId); return fail({ error: 'not_approved', boardItemId: item.id }) }
            const handler = handlers.get(pending.toolName)
            if (!handler) { await release(approvalId); return fail({ error: 'tool_unavailable', tool: pending.toolName }) }
            const result = await handler(withApprovalPrefix(pending.toolName, pending.args, deps.approvalLink(item.id), 'approve'), undefined)
            const text = result.content.map(c => c.text).join('\n')
            if (result.isError) await release(approvalId)
            else await writePrivate(donePath(approvalId), { ...pending, result: text.slice(0, 1_000) })
            return { content: [{ type: 'text', text: receipt({ ok: !result.isError, state: result.isError ? 'dispatch_failed' : 'dispatched', approvalId, choice: 'approve', result: text.slice(0, 200) }) }], isError: result.isError }
        } catch (error) {
            await release(approvalId)
            return fail({ error: 'dispatch_failed', detail: error instanceof Error ? error.message.slice(0, 120) : 'unknown' })
        }
    }

    const { claim, release } = approvalClaims(deps.pendingDir)

    /** The approval whose pending record names this card (the gate's own records only). */
    async function approvalIdForCard(id: string): Promise<string | null> {
        try {
            const { readdir } = await import('node:fs/promises')
            for (const name of await readdir(deps.pendingDir)) {
                if (!name.endsWith('.json') || name.endsWith('.done.json')) continue
                const p = await readJson(join(deps.pendingDir, name))
                if (p?.boardItemId === id && typeof p.approvalId === 'string') return p.approvalId
            }
        } catch { /* no dir yet */ }
        return null
    }
    /** Ids of the cards this gate posted (pending files), for the board write guard. */
    async function isGateCard(id: string): Promise<boolean> {
        return (await approvalIdForCard(id)) !== null
    }

    /**
     * QA77 #2: the main agent's owner_board_post / update / resolve never touch a
     * `main-agent-dispatch:` card; only the gate posts those, outside MCP. Unknown
     * card (lookup failed) on update/resolve → refused, fail-closed.
     */
    async function boardWriteRefusal(name: string, args: Record<string, unknown>): Promise<string | null> {
        if (name === 'owner_board_post') {
            return isReservedCardKey(args?.key) ? 'reserved_card' : null
        }
        const id = typeof args?.id === 'string' ? args.id : ''
        if (!id) return null
        if (await isGateCard(id)) return 'reserved_card'
        if (!deps.board) return null
        try {
            const item = await deps.board.findById(id)
            return isReservedCardKey(item?.key) ? 'reserved_card' : null
        } catch { return 'board_unavailable' }
    }

    return {
        /** Wrap a registrar: dispatch tools gain `risk` and are intercepted; everything else passes through. */
        wrap(mcp: AssistantToolRegistrar): AssistantToolRegistrar {
            const registerTool = ((name: string, config: any, handler: Handler) => {
                if (BOARD_WRITE_TOOLS.has(name)) {
                    return (mcp.registerTool as any)(name, config, async (args: Record<string, unknown>, extra: unknown) => {
                        const refusal = await boardWriteRefusal(name, args ?? {})
                        if (refusal) return fail({ error: refusal, note: 'decision cards of the dispatch gate cannot be posted, edited or closed by the main agent' })
                        return handler(args, extra)
                    })
                }
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
                description: 'Run a dispatch the owner approved on the decision board. Pass the approvalId from the awaiting_decision receipt (or, if you only have the card id from the board message, boardItemId). Runs only when the owner chose 批准执行 (approve) on the unchanged card; 只出草稿 (draft) dispatches nothing — write the draft in chat. Idempotent: a second call returns the first result.',
                title: 'Run Approved Dispatch',
                inputSchema: { approvalId: z.string().min(1).max(64).optional(), boardItemId: z.string().min(1).max(128).optional().describe('The decision card id, when the approvalId is not at hand') },
            }, (args: { approvalId?: unknown; boardItemId?: unknown }) => approved(args))
        },
        /** Test hook. */
        _intercept: intercept,
        _approved: approved,
        _boardWriteRefusal: boardWriteRefusal,
    }
}
export type DispatchGate = ReturnType<typeof createDispatchGate>
