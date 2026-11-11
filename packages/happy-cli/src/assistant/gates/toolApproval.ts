/**
 * Main agent gate 1 — the `ask` branch (B-922, spec §4.4).
 *
 * When the safety setting says `ask` for a tool, the PreToolUse hook does not
 * run the call. It posts a decision card (tool + argument summary) and denies
 * with a note telling the model to wait. After the OWNER chooses on the
 * unchanged card, the SAME call (same tool, arguments hashing the same) is let
 * through:
 *
 *  - 批准这一次 (`once`): exactly one call; the approval is spent on use
 *    (`O_EXCL` marker), the next identical call asks again;
 *  - 以后都允许这个工具 (`always`): this call, and the tool is added to
 *    `safety.allowedTools` (in memory now, account KV for later runs);
 *  - 拒绝 (`deny`): refused.
 *
 * Card checks are the shared owner approval (`attention/ownerApproval.ts`:
 * `ownerDecision` — key, closed, `cardFaceHash`, `resolvedBy='owner'`;
 * `approvalClaims` — the O_EXCL single-use marker), not a copy. Fails closed: no board → refused.
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { MAIN_AGENT_TOOL_ALWAYS_CHOICE, MAIN_AGENT_TOOL_CARD_KEY_PREFIX } from '@slopus/happy-wire'
import { approvalClaims, cardFaceHash, clipBytes, ownerDecision, writePrivateJson } from '@/attention/ownerApproval'
import { canonicalArgsHash, type DispatchBoard } from './dispatchGate'
import type { ToolAsker } from './outboundDenylist'

export const TOOL_APPROVAL_OPTIONS = [
    { id: 'once', label: '批准这一次' },
    { id: MAIN_AGENT_TOOL_ALWAYS_CHOICE, label: '以后都允许这个工具' },
    { id: 'deny', label: '拒绝' },
] as const

export const TOOL_ARGS_SUMMARY_CHARS = 1_500

type ToolApprovalRecord = {
    v: 1
    approvalId: string
    toolName: string
    argsSha256: string
    boardItemId: string
    cardSha256: string
    createdAt: number
}

export function toolCardKey(approvalId: string, toolName: string): string {
    return `${MAIN_AGENT_TOOL_CARD_KEY_PREFIX}${approvalId}:${toolName}`
}

/** Argument summary for the card: pretty JSON, long strings clipped. */
export function toolArgsSummary(input: Record<string, unknown>): string {
    const clip = (value: unknown): unknown => typeof value === 'string' ? (value.length > 400 ? `${value.slice(0, 399)}…` : value)
        : Array.isArray(value) ? value.slice(0, 20).map(clip)
        : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 30).map(([k, v]) => [k, clip(v)]))
        : value
    const text = JSON.stringify(clip(input), null, 2) ?? '{}'
    return text.length > TOOL_ARGS_SUMMARY_CHARS ? `${text.slice(0, TOOL_ARGS_SUMMARY_CHARS - 1)}…` : text
}

export function toolApprovalCard(approvalId: string, toolName: string, input: Record<string, unknown>, argsSha256: string) {
    return {
        key: toolCardKey(approvalId, toolName),
        title: `主 agent 想调用 ${toolName}`.slice(0, 120),
        bodyMd: clipBytes([
            `工具：${toolName}`,
            `参数指纹：${argsSha256.slice(0, 12)}（批准只对这组参数有效）`,
            '',
            '参数：',
            '```json',
            toolArgsSummary(input),
            '```',
            '',
            '批准这一次 = 只放行这一次调用；以后都允许这个工具 = 写进主 agent 安全设置的「已允许工具」；拒绝 = 不执行。',
        ].join('\n'), 7_900),
        requestId: `tool-${approvalId}`,
        options: TOOL_APPROVAL_OPTIONS,
    }
}

export const toolWaitReason = (toolName: string, boardItemId: string) =>
    `已在「需要我决策」出卡（决策 ${boardItemId}），等 Owner 批准这次 ${toolName} 调用。现在先停下，告诉用户在等批准，不要换别的工具绕过；`
    + `Owner 批准后，用完全相同的参数再调用一次 ${toolName}（参数一变就要重新批准）。`
    + ` (Waiting for the owner to approve this call on the decision board. Stop and tell the user; after approval call ${toolName} again with exactly the same arguments.)`

export const toolDeniedReason = (toolName: string, boardItemId: string) =>
    `Owner 拒绝了这次 ${toolName} 调用（决策 ${boardItemId}）。不要用同样的参数重试；需要的话问用户怎么处理。`
    + ' (The owner declined this call. Do not retry it.)'

export type ToolApprovalDeps = {
    /** `~/.happy/assistant/pending-tool` */
    pendingDir: string
    board: DispatchBoard | null
    /** "always": the tool joins the in-memory allow set (CompiledDenylist.allowAlways). */
    allowAlways: (toolName: string) => void
    /** "always": persist to the account setting; best-effort (logged on failure). */
    persistAlways?: (toolName: string) => Promise<unknown>
    now?: () => number
    newId?: () => string
    log?: (line: string) => void
}

export function createToolApproval(deps: ToolApprovalDeps): { ask: ToolAsker } {
    const now = deps.now ?? Date.now
    const newId = deps.newId ?? randomUUID
    const recordPath = (argsSha256: string) => join(deps.pendingDir, `${argsSha256}.json`)
    const claims = approvalClaims(deps.pendingDir)

    async function readRecord(argsSha256: string): Promise<ToolApprovalRecord | null> {
        try { return JSON.parse(await readFile(recordPath(argsSha256), 'utf8')) as ToolApprovalRecord } catch { return null }
    }
    const dropRecord = (argsSha256: string) => unlink(recordPath(argsSha256)).catch(() => {})

    async function postCard(board: DispatchBoard, toolName: string, input: Record<string, unknown>, argsSha256: string): Promise<{ reason: string }> {
        const approvalId = newId()
        const card = toolApprovalCard(approvalId, toolName, input, argsSha256)
        const posted = await board.postDecision(card)
        await mkdir(deps.pendingDir, { recursive: true, mode: 0o700 })
        const record: ToolApprovalRecord = { v: 1, approvalId, toolName, argsSha256, boardItemId: posted.id, cardSha256: cardFaceHash(posted), createdAt: now() }
        await writePrivateJson(recordPath(argsSha256), record)
        deps.log?.(`[main-agent gate] ${toolName} asks the owner (card ${posted.id})`)
        return { reason: toolWaitReason(toolName, posted.id) }
    }

    async function ask(toolName: string, input: Record<string, unknown>): Promise<'allow' | { reason: string }> {
        const board = deps.board
        if (!board) throw new Error('board_unavailable')
        const argsSha256 = canonicalArgsHash(toolName, input)
        const record = await readRecord(argsSha256)
        if (!record || record.toolName !== toolName || record.argsSha256 !== argsSha256 || !record.boardItemId || !record.cardSha256) {
            return postCard(board, toolName, input, argsSha256)
        }
        const decision = ownerDecision(await board.findById(record.boardItemId), { key: toolCardKey(record.approvalId, toolName), cardSha256: record.cardSha256 })
        if (!decision.ok && decision.error === 'awaiting_decision') return { reason: toolWaitReason(toolName, record.boardItemId) }
        if (!decision.ok) {
            // Gone, rewritten, or closed by someone other than the owner: nothing was approved — ask afresh.
            deps.log?.(`[main-agent gate] ${toolName} card ${record.boardItemId}: ${decision.error}`)
            await dropRecord(argsSha256)
            return postCard(board, toolName, input, argsSha256)
        }
        const choice = decision.choice
        if (choice === 'deny') {
            await dropRecord(argsSha256)
            return { reason: toolDeniedReason(toolName, record.boardItemId) }
        }
        if (choice !== 'once' && choice !== MAIN_AGENT_TOOL_ALWAYS_CHOICE) {
            await dropRecord(argsSha256)
            return postCard(board, toolName, input, argsSha256)
        }
        // One call per approval, even under concurrent identical calls.
        await mkdir(deps.pendingDir, { recursive: true, mode: 0o700 })
        const won = await claims.claim(record.approvalId)
        await dropRecord(argsSha256)
        if (!won) return postCard(board, toolName, input, argsSha256)
        if (choice === MAIN_AGENT_TOOL_ALWAYS_CHOICE) {
            deps.allowAlways(toolName)
            try {
                const outcome = await deps.persistAlways?.(toolName)
                deps.log?.(`[main-agent gate] ${toolName} always allowed (persist: ${String(outcome ?? 'skipped')})`)
            } catch (e) {
                deps.log?.(`[main-agent gate] ${toolName} always-allow persist failed: ${e instanceof Error ? e.message : String(e)}`)
            }
        }
        deps.log?.(`[main-agent gate] ${toolName} approved (${choice}, card ${record.boardItemId})`)
        return 'allow'
    }

    return { ask }
}
