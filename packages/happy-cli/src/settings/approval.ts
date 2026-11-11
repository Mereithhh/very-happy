/**
 * B-920 owner decision for a high-risk `very-happy settings set`.
 *
 * Without `--approved`: post a decision card on the calling session's board
 * (key `settings-change:<approvalId>`, options 批准写入 / 放弃) and keep a local
 * pending record; nothing is written.
 *
 * With `--approved <cardId>`: write only when
 *   - the card is one this command posted (reserved key, pending record),
 *   - the OWNER chose 批准写入 on it (server-side `resolvedBy: 'owner'`),
 *   - its face is unchanged since posting (card face hash),
 *   - the face names exactly this {scope, target, key, value fingerprint},
 *   - it has not been used (O_EXCL claim; after the write the card gets an
 *     「已写入」 line, so its face no longer matches and it cannot approve again).
 */

import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
    approvalClaims, cardFaceHash, clipBytes, ownerDecision, SETTINGS_CARD_KEY_PREFIX, writePrivateJson, type BoardItemView,
} from '@/attention/ownerApproval'
import type { SettingsScope } from './policy'

export const SETTINGS_OPTIONS = [
    { id: 'approve', label: '批准写入' },
    { id: 'drop', label: '放弃', recommended: true },
] as const

/** Keys whose value is a secret: the card shows a fingerprint, never the value. */
const SECRET_KEYS = new Set(['inferenceOpenAIKey'])

export type SettingsChange = {
    scope: SettingsScope
    /** Project id, machine id, or '' for the account. */
    target: string
    key: string
    value: unknown
}

function canonical(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonical)
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value as object).sort().map((k) => [k, canonical((value as Record<string, unknown>)[k])]))
    return value
}

export function valueHash(change: SettingsChange): string {
    return createHash('sha256').update(JSON.stringify([change.scope, change.target, change.key, canonical(change.value)])).digest('hex')
}

function shown(key: string, value: unknown): string {
    if (value === undefined) return '（未设置）'
    if (SECRET_KEYS.has(key) && typeof value === 'string' && value) return `（密钥，末 4 位 ${value.slice(-4)}）`
    return clipBytes(JSON.stringify(value), 1_500)
}

/** The lines the approval check reads back from the card face. */
export function bindingLines(change: SettingsChange): string[] {
    return [
        `范围：${change.scope}${change.target ? ` ${change.target}` : ''}`,
        `键：${change.key}`,
        `值指纹：${valueHash(change)}`,
    ]
}

export function settingsCard(change: SettingsChange, current: unknown, approvalId: string, reason: string) {
    return {
        key: `${SETTINGS_CARD_KEY_PREFIX}${approvalId}`,
        title: `要改设置：${change.key}（${change.scope}）`.slice(0, 120),
        bodyMd: clipBytes([
            ...bindingLines(change),
            `批准号：${approvalId}`,
            `原因：${reason}`,
            '',
            `当前值：${shown(change.key, current)}`,
            `新值：${shown(change.key, change.value)}`,
            '',
            '批准后由发起会话执行 `very-happy settings set … --approved <卡片 id>` 写入；只对上面这一个值有效，用过一次即失效。',
        ].join('\n'), 7_900),
        requestId: `settings-${approvalId}`,
    }
}

export type SettingsBoard = {
    post(card: { sessionId: string; key: string; title: string; bodyMd: string; requestId: string; options: Array<{ id: string; label: string; recommended?: boolean }> }): Promise<BoardItemView>
    /** The card with this id among the session's items (any state). Null = not found. */
    findById(sessionId: string, id: string): Promise<BoardItemView | null>
    /** Append a line to the card body (allowed on a closed card). */
    append(id: string, line: string): Promise<void>
}

type Pending = {
    v: 1
    approvalId: string
    sessionId: string
    scope: SettingsScope
    target: string
    key: string
    valueSha256: string
    boardItemId: string
    cardSha256: string
    createdAt: number
    result?: 'written' | 'dropped'
}

export type ApprovalDeps = {
    /** `$HAPPY_HOME_DIR/settings-approvals` */
    dir: string
    board: SettingsBoard
    now?: () => number
    newId?: () => string
}

export function createSettingsApprovals(deps: ApprovalDeps) {
    const now = deps.now ?? Date.now
    const newId = deps.newId ?? randomUUID
    const pendingPath = (id: string) => join(deps.dir, `${id}.json`)
    const { claim, release } = approvalClaims(deps.dir)

    async function readPending(path: string): Promise<Pending | null> {
        try { return JSON.parse(await readFile(path, 'utf8')) as Pending } catch { return null }
    }
    async function pendingForCard(cardId: string): Promise<Pending | null> {
        let names: string[] = []
        try { names = await readdir(deps.dir) } catch { return null }
        for (const name of names) {
            if (!name.endsWith('.json')) continue
            const pending = await readPending(join(deps.dir, name))
            if (pending?.boardItemId === cardId) return pending
        }
        return null
    }

    return {
        /** Post the decision card; nothing is written. */
        async request(change: SettingsChange, current: unknown, sessionId: string, reason: string): Promise<{ cardId: string; approvalId: string }> {
            const approvalId = newId()
            const card = settingsCard(change, current, approvalId, reason)
            await mkdir(deps.dir, { recursive: true, mode: 0o700 })
            const posted = await deps.board.post({ sessionId, ...card, options: SETTINGS_OPTIONS.map((o) => ({ ...o })) })
            const pending: Pending = {
                v: 1, approvalId, sessionId, scope: change.scope, target: change.target, key: change.key,
                valueSha256: valueHash(change), boardItemId: posted.id, cardSha256: cardFaceHash(posted), createdAt: now(),
            }
            await writePrivateJson(pendingPath(approvalId), pending)
            return { cardId: posted.id, approvalId }
        },

        /**
         * Run `write` once if the owner approved exactly this change on card `cardId`.
         * Errors: approval_not_found, approval_mismatch, awaiting_decision, card_tampered,
         * not_approved, approval_dropped, approval_used, board_unavailable.
         */
        async consume(cardId: string, change: SettingsChange, write: () => Promise<void>): Promise<{ ok: true } | { ok: false; error: string; cardId?: string }> {
            const pending = await pendingForCard(cardId)
            if (!pending) return { ok: false, error: 'approval_not_found' }
            if (pending.result === 'written') return { ok: false, error: 'approval_used', cardId }
            if (pending.result === 'dropped') return { ok: false, error: 'approval_dropped', cardId }
            if (pending.scope !== change.scope || pending.target !== change.target || pending.key !== change.key || pending.valueSha256 !== valueHash(change)) {
                return { ok: false, error: 'approval_mismatch', cardId }
            }
            let item: BoardItemView | null
            try { item = await deps.board.findById(pending.sessionId, cardId) } catch { return { ok: false, error: 'board_unavailable' } }
            const decision = ownerDecision(item, { key: `${SETTINGS_CARD_KEY_PREFIX}${pending.approvalId}`, cardSha256: pending.cardSha256 })
            if (!decision.ok) return { ok: false, error: decision.error, cardId }
            // The face itself must name this change (the local record alone is not trusted).
            const face = decision.item.bodyMd ?? ''
            if (!bindingLines(change).every((line) => face.split('\n').includes(line))) return { ok: false, error: 'approval_mismatch', cardId }
            if (!(await claim(pending.approvalId))) return { ok: false, error: 'approval_used', cardId }
            if (decision.choice !== 'approve') {
                await writePrivateJson(pendingPath(pending.approvalId), { ...pending, result: 'dropped' })
                return { ok: false, error: decision.choice === 'drop' ? 'approval_dropped' : 'not_approved', cardId }
            }
            try {
                await write()
            } catch (error) {
                await release(pending.approvalId)
                throw error
            }
            await writePrivateJson(pendingPath(pending.approvalId), { ...pending, result: 'written' })
            // Burn the card: its face no longer hashes to the approved one.
            await deps.board.append(cardId, `已写入（${new Date(now()).toISOString()}）`).catch(() => {})
            return { ok: true }
        },
    }
}
export type SettingsApprovals = ReturnType<typeof createSettingsApprovals>
