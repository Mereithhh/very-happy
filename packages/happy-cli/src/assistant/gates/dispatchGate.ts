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
import { MAIN_AGENT_ASK_TOOLS, MAIN_AGENT_OWNER_ONLY_TOOLS, mainAgentAskAction } from '../mainAgentToolPolicy'
import { runOwnerApproved } from '../turnOrigin'

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

/**
 * B-924b: class-② tools (mainAgentToolPolicy.ts) that are not dispatch tools: no `risk`, no change in the
 * owner's turn. The gate still intercepts them, so a `mustAsk` call (a turn the owner did not type) parks
 * as a decision card and runs only through dispatch_approved — automation_run / fire / resume / pause /
 * delete, issue_assign / issue_comment, project_note, team_* writes.
 */
export const ASK_ONLY_TOOLS: readonly string[] = MAIN_AGENT_ASK_TOOLS.filter(n => !(n in DISPATCH_TOOL_PAYLOADS))
/**
 * B-924f: owner_only tools (mainAgentToolPolicy.ts ①) pass through the gate too. A turn the owner did not type
 * never gets here (withOwnerOnlyTools refuses first); in the owner's turn a call the taint hook flags parks as a
 * decision card and runs only through dispatch_approved.
 */
export const OWNER_ONLY_GATED_TOOLS: readonly string[] = MAIN_AGENT_OWNER_ONLY_TOOLS
function askOnlyPayload(args: Record<string, unknown>): string {
    const head = ['name', 'id', 'issue', 'key', 'issueId', 'teamId', 'taskId', 'title'].map(k => str(args[k])).find(Boolean) ?? ''
    return [head, JSON.stringify(args).slice(0, 1_400)].filter(Boolean).join('\n')
}

/** Which argument receives the approval prefix when a parked call runs. */
const PAYLOAD_FIELD: Readonly<Record<string, string>> = {
    session_spawn: 'prompt', session_send: 'text', terminal_send: 'text', team_delegate: 'goal',
    team_message: 'body', session_message: 'body', lead_delegate: 'goal', lead_message: 'body',
    handoff_send: 'summary',
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
    mustAsk?: (toolName: string, args: Record<string, unknown>) => MustAskVerdict
    /**
     * B-924f taint gate (taintGate.ts): in the owner's turn, the card's 原因 line when the call's key arguments
     * came from recent non-owner prompts and not from the owner's text; null otherwise. Checked after `mustAsk`.
     */
    taint?: (toolName: string, args: Record<string, unknown>) => Promise<string | null>
    /**
     * B-924g (QA-T P3-1): the title of the card's session / team target, for the 目标 line; null = unknown.
     * B-925: best effort — a throw or no answer within TARGET_LABEL_TIMEOUT_MS keeps the raw id. The line is part
     * of the card face, so it is covered by the face hash; the target itself is in the hashed args.
     */
    targetTitle?: (kind: 'session' | 'team', id: string) => Promise<string | null>
    /** B-924g (QA-T P2-2): retry pause while the owner's choice is not readable yet (default 400 ms × 3). */
    settleDelayMs?: number
}
export const TARGET_LABEL_TIMEOUT_MS = 3_000

/** false / null / undefined = no; true = yes (generic reason); a string = yes, and it is the card's 原因 line (B-924b). */
export type MustAskVerdict = boolean | string | null | undefined

type Handler = (args: any, extra?: any) => Promise<ToolResult> | ToolResult

function firstLine(text: string, max: number): string {
    const line = (text.split('\n').find(l => l.trim()) ?? '').trim().replace(/\s+/g, ' ')
    return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/** B-925: one line, no line breaks or quote marks that could fake another field of the card. */
const cleanLabel = (label: string) => label.replace(/[\r\n「」`]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60)

/** B-924g: the session / team a card's 目标 line names (the one whose title the gate looks up). */
export function cardTargetRef(args: Record<string, unknown> | undefined): { kind: 'session' | 'team'; id: string } | null {
    if (!args) return null
    const pick = (...keys: string[]) => keys.map(k => str(args[k])).find(Boolean) ?? ''
    const session = pick('sessionId', 'session_id', 'to')
    if (session) return { kind: 'session', id: session }
    if (Array.isArray(args.session_ids) || pick('terminalId')) return null
    const team = pick('teamId')
    return team ? { kind: 'team', id: team } : null
}

/** B-924c: the card's 目标 line — who receives the text (session / Lead / terminal / team / issue / automation). B-924g: with its title when known. */
export function cardTarget(args: Record<string, unknown> | undefined, title?: string | null): string | null {
    if (!args) return null
    const pick = (...keys: string[]) => keys.map(k => str(args[k])).find(Boolean) ?? ''
    const clean = title ? cleanLabel(title) : ''
    const named = (id: string) => clean ? `「${clean}」（${id}）` : id
    const session = pick('sessionId', 'session_id', 'to') || (Array.isArray(args.session_ids) ? args.session_ids.map(str).filter(Boolean).join(', ') : '')
    if (session) return `会话 ${pick('sessionId', 'session_id', 'to') ? named(session) : session}`
    const terminal = pick('terminalId')
    if (terminal) return `终端 ${terminal}`
    const team = pick('teamId')
    if (team) return `团队 ${named(team)}${pick('taskId', 'botId') ? ` · ${pick('taskId', 'botId')}` : ''}`
    const issue = pick('issue', 'issueId')
    if (issue) return `issue ${issue}`
    const automation = pick('id', 'name')
    return automation ? automation : null
}

/**
 * B-925 (QA-S P3-1): the target's short name for the card TITLE, so two 「继续」 cards to different sessions are
 * told apart in the board list. Same flattening as the 目标 line (no line breaks / 「」 / backticks), capped at
 * 20 chars; the short id when no name is known. Only for receivers that are not already the title's head
 * (session / terminal / team); null otherwise.
 */
export function cardTitleTarget(args: Record<string, unknown> | undefined, title?: string | null): string | null {
    const ref = cardTargetRef(args) ?? (args && str(args.terminalId) ? { kind: 'terminal' as const, id: str(args.terminalId) } : null)
    if (!ref) return null
    const name = title && ref.kind !== 'terminal' ? cleanLabel(title) : ''
    if (name) return `「${name.length > 20 ? `${name.slice(0, 19)}…` : name}」`
    return ref.id.length > 12 ? ` ${ref.id.slice(0, 8)}…` : ` ${ref.id}`
}

export function decisionCard(pending: Pick<PendingDispatch, 'approvalId' | 'toolName' | 'declared' | 'level'> & { args?: Record<string, unknown> }, payload: string, forced: boolean | string = false, targetTitle?: string | null) {
    const head = firstLine(payload, 60) || pending.toolName
    const target = cardTarget(pending.args, targetTitle)
    const titleTarget = cardTitleTarget(pending.args, targetTitle) ?? ''
    return {
        key: `${DISPATCH_CARD_KEY_PREFIX}${pending.approvalId}`,
        // B-924c (QA-T P3-2): the title names the action (想恢复自动化 / 想写项目决定 …), not always 派活.
        // B-925 (QA-S P3-1): …and whom it goes to (想给会话发消息「修 sum.js」).
        title: `主 agent 想${mainAgentAskAction(pending.toolName, pending.args)}${titleTarget}（${pending.level}${forced ? '，需你确认' : ''}）：${head}`.slice(0, 120),
        bodyMd: clipBytes([
            `工具：${pending.toolName}`,
            ...(target ? [`目标：${target}`] : []),
            `风险：${pending.level}（声明 ${pending.declared}${pending.declared === pending.level ? '' : `，复核 ${pending.level}`}）`,
            `批准号：${pending.approvalId}`,
            ...(typeof forced === 'string' && forced ? [forced] : forced ? [pending.toolName === 'terminal_send'
                ? '原因：主 agent 的 Bash 已关闭，往终端里发内容等于直接执行命令，所以每次都先问你。'
                // B-924: the other forced case (sendGuard.ts) — a send to another session in a turn the owner did not type.
                : '原因：这一回合不是你本人发起的（自动化、脚本或别的会话发来的消息），主 agent 给别的会话发消息都先问你。'] : []),
            '',
            '内容：',
            payload.slice(0, 1_500),
        ].join('\n'), 7_900),
        requestId: `dispatch-${pending.approvalId}`,
        options: dispatchOptions(pending.toolName, pending.level),
    }
}

export const DISPATCH_OPTIONS = [
    { id: 'approve', label: '批准执行' },
    { id: 'draft', label: '只出草稿', recommended: true },
    { id: 'drop', label: '放弃' },
] as const

/**
 * B-925 (QA-T B-924c P3): which option the card recommends. A risk-none message into an existing session
 * (session_send / session_message — e.g. 「继续」 to a stuck session) is fully on the card: the target line and the
 * exact text, both hash-bound, sent verbatim. There 批准执行 is the useful default. Everything else (spawns,
 * team / Lead work, automations, terminals, external / production) keeps 只出草稿.
 */
export function dispatchOptions(toolName: string, level: RiskLevel): ReadonlyArray<{ id: string; label: string; recommended?: boolean }> {
    if (level === 'none' && (toolName === 'session_send' || toolName === 'session_message')) {
        return DISPATCH_OPTIONS.map(o => ({ id: o.id, label: o.label, ...(o.id === 'approve' ? { recommended: true } : {}) }))
    }
    return DISPATCH_OPTIONS
}

/**
 * B-925 (QA-T B-924c P2-1): a message into an EXISTING session or terminal goes out exactly as the card showed it.
 * The receiver is mid-conversation; a 「本任务已获批：<url>」 line in front of 「继续」 read as a new instruction it
 * could not place, and in a terminal it would be typed into the shell. The approval stays on the board and in the
 * pending / done records. Work that STARTS somewhere new (a spawn's first prompt, a Lead / team goal, an
 * automation's prompt) keeps the line: that executor has no conversation with the owner and the line is how it
 * knows the owner approved an outbound / production step.
 */
export const VERBATIM_SEND_TOOLS: ReadonlySet<string> = new Set(['session_send', 'session_message', 'terminal_send'])

/** Prefix the approved call's payload; drafts get the do-not-send variant. Verbatim sends are left as approved. */
export function withApprovalPrefix(toolName: string, args: Record<string, unknown>, link: string, choice: 'approve' | 'draft'): Record<string, unknown> {
    if (choice === 'approve' && VERBATIM_SEND_TOOLS.has(toolName)) return args
    const line = choice === 'approve' ? `本任务已获批：${link}` : `本任务已获批，但只出草稿、不得发送或发布：${link}`
    const field = PAYLOAD_FIELD[toolName]
    if (field) return { ...args, [field]: `${line}\n\n${str(args[field])}` }
    if ((toolName === 'automation_create' || toolName === 'automation_update') && args.action && typeof args.action === 'object' && typeof (args.action as any).prompt === 'string') {
        return { ...args, action: { ...(args.action as object), prompt: `${line}\n\n${(args.action as any).prompt}` } }
    }
    return args
}

const APPROVAL_ID_RE = /^[0-9a-f-]{36}$/i

/** B-924g (QA-T P3-2): the main agent said「已催」「已经告诉 T3 了」for a call that was only carded. */
export const AWAITING_NOTE = '还没发出、还没执行：已放到「需要我决策」，等 Owner 在卡上批准。告诉 Owner 这件事在等他批准，不要说「已经发了 / 已经告诉了 / 已催」。这不是出错：不要重试，也不要换别的工具再发。Owner 批准后系统会直接执行并通知你。'
/**
 * B-924i (QA-T R62 P2-2): the parked receipt's first words. The receipt is an error result (isError) so the model
 * cannot read it as "done"; a repeat of the same call in the same turn returns the same card (no new card).
 */
export const AWAITING_STATUS = '未发送：已生成确认卡，等 Owner 在汇报板批准'

/** B-924i (QA-T R62 P2-2): the line the wrapper adds to the chat when a turn ends with calls still on the board. */
export function awaitingTurnNotice(items: ReadonlyArray<{ toolName: string; args: Record<string, unknown>; title?: string | null }>): string | null {
    if (items.length === 0) return null
    const what = items.map(p => { const target = cardTarget(p.args, p.title); return `${mainAgentAskAction(p.toolName, p.args)}${target ? `（${target}）` : ''}` })
    return `［系统提示］${[...new Set(what)].join('；')}：等你在汇报板批准，还没发出。`
}

/** B-924g (QA-T P2-2): the system receipt the main agent gets for the owner's choice on a dispatch card. */
export function dispatchChoiceReceipt(toolName: string, args: Record<string, unknown>, result: { state?: string; error?: string; result?: string }, title?: string | null): string {
    const target = cardTarget(args, title)
    const what = `${toolName}${target ? `（目标：${target}）` : ''}`
    const detail = typeof result.result === 'string' && result.result ? `\n工具结果：${result.result.slice(0, 200)}` : ''
    switch (result.state) {
        case 'dispatched': return `Owner 在「需要我决策」卡上选了「批准执行」。系统已经替你执行了这次 ${what}，只执行这一次。${detail}\n不要再调 dispatch_approved，也不要重新调用 ${toolName}；用一两句话告诉 Owner 已经执行和结果。`
        case 'already_dispatched': return `这张卡批准的 ${what} 已经执行过了（每张卡只执行一次）。${detail}\n不要再调用；告诉 Owner 已经执行过。`
        case 'draft_only': return `Owner 在「需要我决策」卡上选了「只出草稿」：系统没有发出任何内容。现在在对话里把这次 ${what} 要发的内容写成草稿给 Owner 看，不要发送，也不要再调工具。`
        case 'dropped': return `Owner 在「需要我决策」卡上选了「放弃」：${what} 没有执行。不要再试；需要的话问 Owner 接下来怎么办。`
        default: return `系统没有执行这次 ${what}（${result.error ?? result.state ?? 'unknown'}）。告诉 Owner 没有执行和原因，不要自己换别的工具绕过。`
    }
}

export function createDispatchGate(deps: DispatchGateDeps) {
    const now = deps.now ?? Date.now
    const newId = deps.newId ?? randomUUID
    const handlers = new Map<string, Handler>()
    /** B-924i: calls parked since the last turn end (turnEndNotice drains it). */
    const parkedThisTurn: Array<{ approvalId: string; toolName: string; args: Record<string, unknown>; argsSha256: string; title: string | null; result: ToolResult }> = []
    const awaiting = (v: { approvalId: string; boardItemId: string; risk: RiskLevel }): ToolResult =>
        ({ content: [{ type: 'text', text: receipt({ status: AWAITING_STATUS, ok: true, state: 'awaiting_decision', sent: false, ...v, note: AWAITING_NOTE }) }], isError: true })
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
        const verdict = await verdictOf(toolName, args)
        const forced = verdict === true || (typeof verdict === 'string' && verdict.length > 0)
        if (level === 'none' && !forced) return handlers.get(toolName)!(args, extra)
        // B-922: the owner chose "直接派" for this level (default ask = B-916c).
        const policy = deps.dispatchPolicy?.()
        if (!forced && level !== 'none' && policy && policy[level] === 'direct') {
            deps.log?.(`[main-agent gate] ${toolName} ${level} dispatched directly (owner setting)`)
            return handlers.get(toolName)!(args, extra)
        }
        return park(toolName, args, risk, level, payload, typeof verdict === 'string' ? verdict : forced)
    }

    /** B-924b: an ASK_ONLY_TOOLS call — runs unless `mustAsk`, then parks like a forced dispatch (risk none). */
    async function interceptAskOnly(toolName: string, rawArgs: Record<string, unknown>, extra: unknown): Promise<ToolResult> {
        const args = rawArgs ?? {}
        const verdict = await verdictOf(toolName, args)
        if (!(verdict === true || (typeof verdict === 'string' && verdict.length > 0))) return handlers.get(toolName)!(args, extra)
        deps.log?.(`[main-agent gate] ${toolName} must ask (${typeof verdict === 'string' ? 'reason' : 'forced'})`)
        return park(toolName, args, 'none', 'none', askOnlyPayload(args), verdict)
    }

    /** B-925: the target's title for the card, or null (no lookup, a throw, or no answer within TARGET_LABEL_TIMEOUT_MS). */
    async function titleFor(args: Record<string, unknown>): Promise<string | null> {
        const ref = cardTargetRef(args)
        if (!ref || !deps.targetTitle) return null
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
            return await Promise.race([
                deps.targetTitle(ref.kind, ref.id),
                new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), TARGET_LABEL_TIMEOUT_MS); timer.unref?.() }),
            ])
        } catch { return null } finally { if (timer) clearTimeout(timer) }
    }

    /** `mustAsk` first (sync rules), then the B-924f taint hook. */
    async function verdictOf(toolName: string, args: Record<string, unknown>): Promise<MustAskVerdict> {
        const verdict = deps.mustAsk?.(toolName, args)
        if (verdict === true || (typeof verdict === 'string' && verdict.length > 0)) return verdict
        return (await deps.taint?.(toolName, args)) ?? verdict
    }

    /** B-924f: an owner_only call that reached the gate (the owner's turn) — runs unless the taint hook flags it. */
    async function interceptOwnerOnly(toolName: string, rawArgs: Record<string, unknown>, extra: unknown): Promise<ToolResult> {
        const args = rawArgs ?? {}
        const reason = await deps.taint?.(toolName, args)
        if (!reason) return handlers.get(toolName)!(args, extra)
        deps.log?.(`[main-agent gate] ${toolName} tainted, parked`)
        return park(toolName, args, 'none', 'none', toolName === 'handoff_send' ? str(args.summary) || askOnlyPayload(args) : askOnlyPayload(args), reason)
    }

    async function park(toolName: string, args: Record<string, unknown>, declared: RiskLevel, level: RiskLevel, payload: string, forced: boolean | string): Promise<ToolResult> {
        if (!deps.board) return fail({ error: 'board_unavailable', risk: level })
        // B-924i: the same call again in this turn (a retry after the error result) → the card already posted.
        const sha = canonicalArgsHash(toolName, args)
        const again = parkedThisTurn.find(p => p.argsSha256 === sha)
        if (again && !(await readJson(donePath(again.approvalId)))) {
            deps.log?.(`[main-agent gate] ${toolName} repeated in the turn → card ${again.approvalId}`)
            return again.result
        }
        const approvalId = newId()
        const pending: PendingDispatch = { v: 1, approvalId, toolName, args, argsSha256: canonicalArgsHash(toolName, args), declared, level, createdAt: now() }
        try {
            await mkdir(deps.pendingDir, { recursive: true, mode: 0o700 })
            await writePrivate(pendingPath(approvalId), pending)
            const title = await titleFor(args)
            const card = decisionCard(pending, payload, forced, title)
            const posted = await deps.board.postDecision(card)
            const id = posted.id
            await writePrivate(pendingPath(approvalId), { ...pending, boardItemId: id, cardSha256: cardFaceHash(posted) })
            const result = awaiting({ approvalId, boardItemId: id, risk: level })
            parkedThisTurn.push({ approvalId, toolName, args, argsSha256: pending.argsSha256, title, result })
            return result
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
            // B-924g: the owner approved this exact call — the tool's own owner checks see the owner (turnOrigin.ts).
            const result = await runOwnerApproved(async () => handler(withApprovalPrefix(pending.toolName, pending.args, deps.approvalLink(item.id), 'approve'), undefined))
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

    /**
     * B-924g (QA-T P2-2): the owner chose on one of this gate's cards → run `approved` here (same checks, same
     * single-use claim), so the approved call never depends on the model calling dispatch_approved. A choice
     * the server does not show yet is retried briefly; null = not this gate's card.
     */
    async function runBoardChoice(itemId: string): Promise<string | null> {
        const approvalId = await approvalIdForCard(itemId)
        if (!approvalId) return null
        const pending = await readJson(pendingPath(approvalId))
        if (!pending) return null
        const parse = (r: ToolResult): { state?: string; error?: string; result?: string } => {
            const text = r.content.map(c => c.text).join('')
            try { return JSON.parse(text) } catch { /* a clipped receipt */ }
            const field = (k: string) => text.match(new RegExp(`"${k}":"([^"]*)"`))?.[1]
            return { state: field('state'), error: field('error') ?? (field('state') ? undefined : 'unreadable'), result: field('result') }
        }
        let out = parse(await approved({ approvalId }))
        for (let i = 0; i < 3 && out.error === 'awaiting_decision'; i++) {
            await new Promise(r => setTimeout(r, deps.settleDelayMs ?? 400))
            out = parse(await approved({ approvalId }))
        }
        deps.log?.(`[main-agent gate] card ${itemId} chosen → ${out.state ?? out.error}`)
        return dispatchChoiceReceipt(pending.toolName, pending.args, out, await titleFor(pending.args))
    }

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
                if (OWNER_ONLY_GATED_TOOLS.includes(name)) {
                    handlers.set(name, handler)
                    return (mcp.registerTool as any)(name, config, (args: Record<string, unknown>, extra: unknown) => interceptOwnerOnly(name, args, extra))
                }
                if (ASK_ONLY_TOOLS.includes(name)) {
                    handlers.set(name, handler)
                    return (mcp.registerTool as any)(name, config, (args: Record<string, unknown>, extra: unknown) => interceptAskOnly(name, args, extra))
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
        /** B-924g: systemCardChoice.ts runner for this gate's cards. */
        runBoardChoice,
        /**
         * B-924i (QA-T R62 P2-2): at a turn's end, the chat line for the calls this turn parked whose card is still
         * undecided (null = none). Drains the turn's list, whatever the model said about them.
         */
        /** B-924i: a new turn — the same call again parks a new card (the retry dedupe is per turn). */
        onTurnStart(): void { parkedThisTurn.length = 0 },
        async turnEndNotice(): Promise<string | null> {
            const items = parkedThisTurn.splice(0)
            const open: typeof items = []
            for (const p of items) if (!(await readJson(donePath(p.approvalId)))) open.push(p)
            return awaitingTurnNotice(open)
        },
        /** Test hook. */
        _intercept: intercept,
        _interceptAskOnly: interceptAskOnly,
        _interceptOwnerOnly: interceptOwnerOnly,
        _approved: approved,
        _boardWriteRefusal: boardWriteRefusal,
    }
}
export type DispatchGate = ReturnType<typeof createDispatchGate>
