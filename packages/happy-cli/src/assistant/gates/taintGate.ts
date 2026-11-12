/**
 * B-924f: the taint gate's hook for the dispatch gate (promptTaint.ts has the rule and the spec).
 *
 * `mainAgentTaintHook` answers, for one owner_only / ask-class call in the owner's turn, the card's 原因 line
 * when its key arguments came from recent non-owner prompts and not from what the owner typed — or null.
 * Session and team targets are looked up by title first (the injection names「T4」, the model passes T4's id).
 */

import { isOwnerTurn } from '../turnOrigin'
import { isLedgerSend } from '../sendGuard'
import { MAIN_AGENT_ASK_TOOLS, MAIN_AGENT_OWNER_ONLY_TOOLS } from '../mainAgentToolPolicy'
import { mainAgentPromptTaint, promptTaintHits, promptTaintReason, taintKeys, type TaintSnapshot } from '../promptTaint'

/** Every owner_only and ask-class tool (mainAgentToolPolicy.ts ① + ②). */
export const TAINT_CHECKED_TOOLS: ReadonlySet<string> = new Set<string>([...MAIN_AGENT_OWNER_ONLY_TOOLS, ...MAIN_AGENT_ASK_TOOLS])

/** Titles of a session / team id; [] = none known; null = lookup failed. */
export type TitlesOf = (kind: 'session' | 'team', id: string) => Promise<string[] | null>

let installedTitlesOf: TitlesOf = async () => null
/** startHappyServer installs the live lookup (taintTitles.ts); nothing installed = lookup fails (sessions fail closed). */
export function installTaintTitlesOf(next: TitlesOf | null): void { installedTitlesOf = next ?? (async () => null) }

export function mainAgentTaintHook(deps: { snapshot?: () => TaintSnapshot; titlesOf?: TitlesOf; isOwner?: () => boolean; log?: (line: string) => void } = {}) {
    const snapshotOf = deps.snapshot ?? mainAgentPromptTaint
    const titlesOf: TitlesOf = deps.titlesOf ?? ((kind, id) => installedTitlesOf(kind, id))
    const isOwner = deps.isOwner ?? isOwnerTurn
    return async (toolName: string, args: Record<string, unknown>): Promise<string | null> => {
        if (!TAINT_CHECKED_TOOLS.has(toolName) || !isOwner()) return null
        // A session / Lead / terminal the main agent started itself (B-925 ledger): sent to directly in any turn.
        if (isLedgerSend(toolName, args ?? {})) return null
        const snapshot = snapshotOf()
        if (snapshot.ownerText === null || snapshot.nonOwner.length === 0) return null
        const keys = taintKeys(args ?? {})
        const unresolved = new Set<string>()
        for (const target of keys.targets) {
            if (target.kind === 'other') continue
            const titles = await titlesOf(target.kind, target.value).catch(() => null)
            if (titles) target.titles = titles.filter(t => typeof t === 'string' && t.trim())
            else if (target.kind === 'session') unresolved.add(target.value)
        }
        const hits = promptTaintHits(keys, snapshot, unresolved)
        if (!hits.length) return null
        deps.log?.(`[main-agent gate] ${toolName} tainted: ${hits.map(h => h.kind).join(',')}`)
        return promptTaintReason(hits)
    }
}

