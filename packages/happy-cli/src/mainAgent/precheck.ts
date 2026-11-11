/**
 * B-924: `very-happy main-agent precheck <brief|stuck|wrapup>` — the zero-token
 * gate of the main agent's default automations (B-548 precheck: exit 0 runs
 * the action with this stdout appended to the prompt; any other exit records
 * the run `skipped` and the main agent is not woken).
 *
 *  - brief  always passes (the snapshot is the brief's input).
 *  - stuck  passes only for stuck sessions it has not reported before.
 *  - wrapup passes only for candidates it has not suggested before.
 *
 * "Reported before" is a small local ledger per kind (key → when), forgotten
 * after `SEEN_TTL_MS` so a session still stuck a week later comes back once.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { MainAgentAutomationKind } from '@slopus/happy-wire'
import { briefSnapshot, findStuckSessions, findWrapupCandidates, formatBrief, formatStuck, formatWrapup, stuckKeys, wrapupKeys, type ScanDeps } from './scan'

export const SEEN_TTL_MS = 7 * 86_400_000
export const SEEN_MAX = 500
export const PRECHECK_SKIP_EXIT = 3

export type SeenLedger = Record<string, number>
export type LedgerIo = { read: (kind: MainAgentAutomationKind) => Promise<SeenLedger>; write: (kind: MainAgentAutomationKind, ledger: SeenLedger) => Promise<void> }

export function fileLedger(dir: string): LedgerIo {
    const path = (kind: string) => join(dir, `precheck-${kind}.json`)
    return {
        async read(kind) {
            try {
                const raw = JSON.parse(await readFile(path(kind), 'utf8'))
                const out: SeenLedger = {}
                if (raw && typeof raw === 'object' && raw.seen && typeof raw.seen === 'object') for (const [k, v] of Object.entries(raw.seen)) if (typeof v === 'number') out[k] = v
                return out
            } catch { return {} }
        },
        async write(kind, ledger) {
            const file = path(kind)
            await mkdir(dirname(file), { recursive: true })
            const tmp = `${file}.${process.pid}.tmp`
            await writeFile(tmp, JSON.stringify({ v: 1, seen: ledger }), { mode: 0o600 })
            await rename(tmp, file)
        },
    }
}

/** Keys not in the ledger (or older than the TTL), and the ledger with them added. */
export function newKeys(ledger: SeenLedger, keys: readonly string[], now: number): { fresh: Set<string>; next: SeenLedger } {
    const kept = Object.entries(ledger).filter(([, at]) => now - at < SEEN_TTL_MS)
    const live = new Map(kept)
    const fresh = new Set(keys.filter(k => !live.has(k)))
    for (const k of fresh) live.set(k, now)
    const entries = [...live.entries()].sort((a, b) => a[1] - b[1]).slice(-SEEN_MAX)
    return { fresh, next: Object.fromEntries(entries) }
}

export type PrecheckOutcome = { exitCode: number; stdout: string }

/**
 * `record` (QA P3-6): only the automation's own call (`--record`) remembers what
 * it reported; a manual run just shows what is new, so the next real run still
 * posts its cards.
 */
export async function runMainAgentPrecheck(kind: MainAgentAutomationKind, deps: ScanDeps, ledger: LedgerIo, options: { record?: boolean } = {}): Promise<PrecheckOutcome> {
    const record = options.record === true
    const now = deps.now()
    if (kind === 'brief') return { exitCode: 0, stdout: formatBrief(await briefSnapshot(deps), now) }
    if (kind === 'stuck') {
        const list = await findStuckSessions(deps)
        const keys = stuckKeys(list)
        const { fresh, next } = newKeys(await ledger.read(kind), keys, now)
        const report = list.filter((_, i) => fresh.has(keys[i]))
        if (!report.length) return { exitCode: PRECHECK_SKIP_EXIT, stdout: list.length ? `no change: ${list.length} stuck session(s), all reported before` : 'nothing stuck' }
        if (record) await ledger.write(kind, next)
        return { exitCode: 0, stdout: formatStuck(report, now) }
    }
    const list = await findWrapupCandidates(deps)
    const { fresh, next } = newKeys(await ledger.read(kind), wrapupKeys(list), now)
    const report = list.filter(c => fresh.has(c.sessionId))
    if (!report.length) return { exitCode: PRECHECK_SKIP_EXIT, stdout: list.length ? `no change: ${list.length} candidate(s), all suggested before` : 'nothing to wrap up' }
    if (record) await ledger.write(kind, next)
    return { exitCode: 0, stdout: formatWrapup(report) }
}
