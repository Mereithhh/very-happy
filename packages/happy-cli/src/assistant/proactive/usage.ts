/**
 * B-925: tokens spent by the main agent's woken turns, for the daily budget.
 *
 * The main agent's wrapper sees every Claude line of its own session. A turn
 * whose prompts are all wake-ups (`automation-wake-…`) is counted: per
 * assistant message id the latest usage (input + output + cache writes; cache
 * reads are not counted), appended at turn end to
 * `~/.happy/assistant/proactive-usage.jsonl`. The daemon sums a local day.
 */

import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { mainAgentWakeLevelOf, type MainAgentProactiveLevel } from '@slopus/happy-wire'
import { withFileLock } from './ledger'
import { localDay } from './quietHours'

export function proactiveUsagePath(home: string): string {
    return join(home, 'proactive-usage.jsonl')
}

/** The wake level of a turn: every prompt is a wake-up; a mixed batch with a report-only wake stays report-only. */
export function wakeTurnLevel(sourceIds: readonly string[] | undefined): Exclude<MainAgentProactiveLevel, 'off'> | null {
    if (!sourceIds?.length) return null
    const levels = sourceIds.map(id => mainAgentWakeLevelOf(id))
    if (levels.some(l => l === null)) return null
    return levels.includes('report') ? 'report' : 'follow'
}

function usageTokens(usage: unknown): number {
    if (!usage || typeof usage !== 'object') return 0
    const u = usage as Record<string, unknown>
    const n = (k: string) => typeof u[k] === 'number' && Number.isFinite(u[k] as number) && (u[k] as number) > 0 ? u[k] as number : 0
    return n('input_tokens') + n('output_tokens') + n('cache_creation_input_tokens')
}

export function createWakeUsageTracker(deps: { path: string; now?: () => number; log?: (line: string) => void }) {
    const now = deps.now ?? Date.now
    let level: Exclude<MainAgentProactiveLevel, 'off'> | null = null
    let wakeIds: string[] = []
    const perMessage = new Map<string, number>()
    return {
        onTurnStart(sourceIds: readonly string[] | undefined): void {
            level = wakeTurnLevel(sourceIds)
            wakeIds = level ? [...sourceIds!] : []
            perMessage.clear()
        },
        onClaudeLine(body: unknown): void {
            if (!level) return
            const line = body as { type?: string; isSidechain?: boolean; message?: { id?: string; usage?: unknown } } | null
            if (line?.type !== 'assistant' || !line.message?.usage) return
            const id = typeof line.message.id === 'string' ? line.message.id : `anon-${perMessage.size}`
            perMessage.set(id, usageTokens(line.message.usage))
        },
        async onTurnEnd(): Promise<void> {
            if (!level) return
            const tokens = [...perMessage.values()].reduce((a, b) => a + b, 0)
            const ids = wakeIds
            level = null
            wakeIds = []
            perMessage.clear()
            try {
                await mkdir(dirname(deps.path), { recursive: true })
                await withFileLock(deps.path, () => appendFile(deps.path, `${JSON.stringify({ at: now(), wake: ids.slice(0, 4), tokens })}\n`, { mode: 0o600 }))
            } catch (error) { deps.log?.(`[main-agent wake] usage not recorded: ${error instanceof Error ? error.message : String(error)}`) }
        },
        /** The wake level of the turn in progress (null = not a wake turn). */
        level: () => level,
    }
}
export type WakeUsageTracker = ReturnType<typeof createWakeUsageTracker>

/** Sum of tokens on `day` (local in `tz`); trims lines older than 3 days while it holds the lock. */
export async function wakeTokensOn(path: string, day: string, tz: string, now = Date.now()): Promise<number> {
    let text = ''
    try { text = await readFile(path, 'utf8') } catch { return 0 }
    let sum = 0
    let stale = 0
    for (const raw of text.split('\n')) {
        if (!raw.trim()) continue
        try {
            const line = JSON.parse(raw) as { at?: unknown; tokens?: unknown }
            if (typeof line.at !== 'number' || typeof line.tokens !== 'number') continue
            if (now - line.at > 3 * 24 * 60 * 60_000) { stale++; continue }
            if (localDay(line.at, tz) === day) sum += line.tokens
        } catch { /* skip */ }
    }
    if (stale > 0) {
        await withFileLock(path, async () => {
            const fresh = (await readFile(path, 'utf8')).split('\n').filter(raw => {
                try { const at = (JSON.parse(raw) as { at?: unknown }).at; return typeof at === 'number' && now - at <= 3 * 24 * 60 * 60_000 } catch { return false }
            })
            await writeFile(path, fresh.length ? `${fresh.join('\n')}\n` : '', { mode: 0o600 })
        }).catch(() => {})
    }
    return sum
}
