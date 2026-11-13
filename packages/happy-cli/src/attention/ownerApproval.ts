/**
 * Owner approval on a briefing-board decision card — the part shared by the
 * main agent's dispatch gate (B-916c gate 2) and `very-happy settings set`
 * (B-920).
 *
 * An approval counts only when:
 *  - the card was closed by the OWNER (`resolvedBy === 'owner'`; the server sets
 *    that only on `owner-respond`, which requires a signed-in Web login — a
 *    machine / agent token is refused there);
 *  - the card FACE (key, title, body, option ids + labels) still hashes to what
 *    was posted, so a card rewritten after posting (`card_tampered`) approves
 *    nothing;
 *  - the action has not run before (O_EXCL `.inflight` marker per approval).
 *
 * Cards under a reserved key prefix are posted only by these gates, never by an
 * agent's own `owner_board_*` tools.
 */

import { createHash, randomUUID } from 'node:crypto'
import { open, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { MAIN_AGENT_CARD_KEY, MAIN_AGENT_TOOL_CARD_KEY_PREFIX } from '@slopus/happy-wire'

export const DISPATCH_CARD_KEY_PREFIX = 'main-agent-dispatch:'
export const SETTINGS_CARD_KEY_PREFIX = 'settings-change:'
/** B-922: gate 1's tool approval cards (`main-agent-tool:<approvalId>:<tool>`) are reserved too. */
// B-924: the main agent's wrap-up checklist (`main-agent-wrapup:`) is posted only by wrapup_suggest.
export const RESERVED_CARD_KEY_PREFIXES = [DISPATCH_CARD_KEY_PREFIX, SETTINGS_CARD_KEY_PREFIX, MAIN_AGENT_TOOL_CARD_KEY_PREFIX, MAIN_AGENT_CARD_KEY.wrapup] as const

/** QA80 P3: the reserved prefix matches after trim + lowercase (`  MAIN-AGENT-DISPATCH:x` is reserved too). */
export function isReservedCardKey(key: unknown): boolean {
    if (typeof key !== 'string') return false
    const normalized = key.trim().toLowerCase()
    return RESERVED_CARD_KEY_PREFIXES.some((prefix) => normalized.startsWith(prefix))
}

export type BoardItemView = {
    id: string; key: string | null; state: string; ownerChoice: string | null; resolvedBy: string | null
    /** Card face (what the owner saw when choosing). */
    title: string; bodyMd: string | null; options: Array<{ id: string; label: string }> | null
}

/** Narrow a server item to the fields an approval reads. */
export function boardItemView(item: { id: string; key?: string | null; state: string; ownerChoice?: string | null; resolvedBy?: string | null; title: string; bodyMd?: string | null; options?: Array<{ id: string; label: string }> | null }): BoardItemView {
    return {
        id: item.id, key: item.key ?? null, state: item.state, ownerChoice: item.ownerChoice ?? null, resolvedBy: item.resolvedBy ?? null,
        title: item.title, bodyMd: item.bodyMd ?? null, options: item.options ? item.options.map(o => ({ id: o.id, label: o.label })) : null,
    }
}

/**
 * QA77 P1: the approval is bound to the card FACE the owner chose on. Hash of
 * {key, title, body_md, options[].id+label} as the server stored it at post
 * time; the approval re-reads the card and refuses on any difference.
 */
export function cardFaceHash(item: Pick<BoardItemView, 'key' | 'title' | 'bodyMd' | 'options'>): string {
    const face = {
        key: item.key ?? null,
        title: item.title ?? '',
        body_md: item.bodyMd ?? '',
        options: (item.options ?? []).map(o => ({ id: String(o.id), label: String(o.label) })),
    }
    return createHash('sha256').update(JSON.stringify(face)).digest('hex')
}

export type OwnerDecision =
    | { ok: true; choice: string; item: BoardItemView }
    | { ok: false; error: 'approval_not_found' | 'awaiting_decision' | 'card_tampered' | 'not_approved'; boardItemId?: string }

/**
 * Check a re-read card against what was posted. `ok` returns the owner's choice;
 * the caller decides what each choice does (only its approve id acts).
 */
export function ownerDecision(item: BoardItemView | null, expected: { key: string; cardSha256: string }): OwnerDecision {
    if (!item || item.key !== expected.key) return { ok: false, error: 'approval_not_found' }
    if (item.state === 'open' || item.state === 'in_progress') return { ok: false, error: 'awaiting_decision', boardItemId: item.id }
    if (cardFaceHash(item) !== expected.cardSha256) return { ok: false, error: 'card_tampered', boardItemId: item.id }
    if (item.resolvedBy !== 'owner' || !item.ownerChoice) return { ok: false, error: 'not_approved', boardItemId: item.id }
    return { ok: true, choice: item.ownerChoice, item }
}

/** One run per approval, even under concurrent calls: an O_EXCL marker in `dir`. */
export function approvalClaims(dir: string) {
    const inflightPath = (id: string) => join(dir, `${id}.inflight`)
    return {
        async claim(id: string): Promise<boolean> {
            try { const fh = await open(inflightPath(id), 'wx', 0o600); await fh.close(); return true }
            catch (error: any) { if (error?.code === 'EEXIST') return false; throw error }
        },
        async release(id: string): Promise<void> { await unlink(inflightPath(id)).catch(() => {}) },
    }
}

/** Atomic 0600 JSON write (tmp + rename). */
export async function writePrivateJson(path: string, value: unknown): Promise<void> {
    const tmp = `${path}.${randomUUID()}.tmp`
    await writeFile(tmp, JSON.stringify(value), { mode: 0o600 })
    await rename(tmp, path)
}

/** Clip a string to a UTF-8 byte budget. */
export function clipBytes(text: string, bytes: number): string {
    const enc = new TextEncoder()
    if (enc.encode(text).length <= bytes) return text
    let out = text.slice(0, bytes)
    while (enc.encode(out).length > bytes - 3) out = out.slice(0, -1)
    return out + '…'
}
