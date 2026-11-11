/**
 * Main agent start-up wiring (B-916c). One call from runClaude for an
 * assistant-variant session outside any team scope:
 *
 *  1. load config (KV ∪ local), compile the outbound denylist (gate 1);
 *  2. install the `very-happy-main-agent` skill and re-render the CLAUDE.md
 *     managed segment (skill paths + skillRoots);
 *  3. build the dispatch gate (gate 2) on the briefing board.
 *
 * Every step degrades on failure except the denylist, which always holds the
 * defaults: a broken KV or file never lifts gate 1 (B-922: an unreadable
 * safety setting reads as the strict preset).
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { mainAgentMustAsk, mustAskReasonLine, nonOwnerThirdPartyReason } from '../sendGuard'
import type { AttentionClient } from '@/attention/client'
import { assistantHome } from '../bootstrap'
import { installMainAgentSkill, renderManagedSegment, writeManagedSegment } from '../mainAgentSkill'
import { MAIN_AGENT_SAFETY_CAPABILITY, PRESET_POLICIES } from '@slopus/happy-wire'
import type { KvIo } from '../mainAgentPointer'
import { expandHome, loadMainAgentConfig, persistAllowedTool, type MainAgentConfig, type MainAgentSafetyRuntime } from './config'
import { compileOutboundDenylist, outboundPreToolUseHook, type CompiledDenylist, type ToolAsker, type ToolDecision } from './outboundDenylist'
import { cardLang, createToolApproval, type CardLang, type ToolApprovalDeps } from './toolApproval'
import { happyHomeCandidates, MAIN_AGENT_APPROVALS_DIR, protectedPathsFor } from './protectedPaths'
import { createDispatchGate, DISPATCH_OPTIONS, type DispatchBoard, type DispatchGate } from './dispatchGate'
import type { OneShotRunner } from './risk'
import { boardItemView as view, clipBytes } from '@/attention/ownerApproval'

export const MAIN_AGENT_GATES_CAPABILITY = 'main-agent-gates-v1'
/** B-922: the wrapper enforces the configurable safety setting (presets, ask cards, gate 2 policy). */
export { MAIN_AGENT_SAFETY_CAPABILITY }

const STRICT_RUNTIME = (): MainAgentSafetyRuntime => ({ safety: { v: 1, preset: 'strict', overrides: {}, allowedTools: [] }, policy: { ...PRESET_POLICIES.strict }, allowedTools: [], failedClosed: true })

export type MainAgentRuntime = {
    config: MainAgentConfig
    /** B-922: the safety setting in force (strict when it could not be read). */
    safety: MainAgentSafetyRuntime
    denylist: CompiledDenylist
    /** SDK `hooks.PreToolUse` callback. */
    preToolUse: ReturnType<typeof outboundPreToolUseHook>
    /** Existing skillRoots, for SDK `additionalDirectories`. */
    extraDirectories: string[]
    gate: DispatchGate
}

export function attentionDispatchBoard(client: AttentionClient, sessionId: () => string): DispatchBoard {
    const all = async () => (await client.list({ sessionId: sessionId(), state: 'all', limit: 200 })).items
    return {
        async postDecision(card) {
            const { item } = await client.post({
                sessionId: sessionId(), source: 'agent', kind: 'decision',
                title: card.title, bodyMd: card.bodyMd, key: card.key, requestId: card.requestId,
                options: (card.options ?? DISPATCH_OPTIONS).map(o => ({ ...o })),
            })
            return view(item)
        },
        async findByKey(key) {
            const item = (await all()).find(i => i.key === key)
            return item ? view(item) : null
        },
        async findById(id) {
            const item = (await all()).find(i => i.id === id)
            return item ? view(item) : null
        },
    }
}

export async function prepareMainAgent(deps: {
    kvGet: (key: string) => Promise<{ value: string } | null>
    /** B-922: KV writer for "always allow" (machine token). Absent = in-memory only. */
    kv?: KvIo
    board: DispatchBoard | null
    classify: OneShotRunner | null
    approvalLink: (boardItemId: string) => string
    home?: string
    assistantHomeDir?: string
    /** HAPPY_HOME (credentials + approval records). Default: the configured one; tests pass a temp dir. */
    happyHomeDir?: string
    /** B-922 card language ('zh' | 'en'); default from the account preferredLanguage, unset → 'zh' (runClaude). */
    lang?: 'zh' | 'en'
    log?: (line: string) => void
    /** Who started the current turn; default the installed tracker (turnOrigin.ts). Tests pass their own. */
    isOwner?: () => boolean
}): Promise<MainAgentRuntime> {
    const home = deps.home ?? homedir()
    const aHome = deps.assistantHomeDir ?? assistantHome()
    // Test isolation: a given assistant home without a HAPPY_HOME keeps everything inside it.
    const happyHome = deps.happyHomeDir ?? (deps.assistantHomeDir ? aHome : dirname(assistantHome()))
    // QA P2-2: approval records live outside the assistant home (the agent's cwd, which it greps).
    const approvalsDir = join(happyHome, MAIN_AGENT_APPROVALS_DIR)
    const config: MainAgentConfig = await loadMainAgentConfig({ assistantHome: aHome, kvGet: deps.kvGet }).catch(() => ({ skillRoots: [], deniedTools: [], dropped: 0 }))
    if (config.dropped > 0) deps.log?.(`[main-agent] dropped ${config.dropped} invalid config item(s)`)
    const safety = config.safety ?? STRICT_RUNTIME()
    if (safety.failedClosed) deps.log?.('[main-agent] safety setting unreadable or not understood: strict')
    const denylist = compileOutboundDenylist(config.deniedTools, { policy: safety.policy, allowedTools: safety.allowedTools })
    const approvalDeps: ToolApprovalDeps = {
        pendingDir: join(approvalsDir, 'pending-tool'),
        lang: deps.lang ?? cardLang(null),
        board: deps.board,
        allowAlways: (tool) => denylist.allowAlways(tool),
        persistAlways: deps.kv ? (tool) => persistAllowedTool(deps.kv!, tool) : undefined,
        log: deps.log,
    }
    // Calls that always park, whatever their risk / preset — gate 2 AND (B-924c) gate 1's third-party MCP calls.
    // B-922: terminal_send while Bash is off. B-924: sends to other sessions in a turn the owner did not type (sendGuard.ts).
    // B-924b: the card says which rule fired. B-924c: third-party outbound / production / write tools in a non-owner turn.
    const mustAsk = mainAgentMustAskHook(() => safety.policy.bash, deps.isOwner)
    const gate1 = withGate1MustAsk(denylist, approvalDeps, mustAsk)
    const roots = config.skillRoots.map(r => { const path = expandHome(r, home); return { path, exists: existsSync(path) } })
    let skillPath: string | null = null
    try {
        skillPath = await installMainAgentSkill(home, deps.log)
        const segment = renderManagedSegment({ skillPaths: skillPath ? [skillPath] : [], skillRoots: roots })
        await writeManagedSegment(join(aHome, 'CLAUDE.md'), segment, deps.log)
    } catch (error) {
        deps.log?.(`[main-agent] managed segment failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    const gate = createDispatchGate({
        pendingDir: join(approvalsDir, 'pending-dispatch'),
        board: deps.board,
        classify: deps.classify,
        approvalLink: deps.approvalLink,
        log: deps.log,
        dispatchPolicy: () => ({ external: safety.policy.dispatchExternal, production: safety.policy.dispatchProduction }),
        mustAsk,
    })
    return {
        config,
        safety,
        denylist,
        // QA P2-2: HAPPY_HOME is closed to the file tools (read allowlist: CLAUDE.md, memory/, chat uploads).
        preToolUse: outboundPreToolUseHook(gate1, (tool) => deps.log?.(`[main-agent gate] denied ${tool}`), gate1.ask,
            protectedPathsFor(happyHomeCandidates(deps.happyHomeDir ?? dirname(assistantHome())), { home })),
        // The managed skills live outside the assistant home: mount the whole Very Happy share root
        // (`~/.local/share/very-happy`), or every Read / Grep of the handbook asks for permission in
        // the default mode (isolated probe; QA77 #7: a Grep one level up asked too).
        extraDirectories: [...(skillPath ? [dirname(dirname(dirname(skillPath)))] : []), ...roots.filter(r => r.exists).map(r => r.path)],
        gate,
    }
}

/**
 * B-922 (QA P3): the gate-1 card language — the account's `preferredLanguage`
 * (the same setting the Web uses); unset or unreadable → Chinese (QA-U r2 P3-2).
 */
export async function accountCardLang(timeoutMs = 5_000): Promise<CardLang> {
    try {
        const { accountKey, createAccountStore } = await import('@/settings/stores')
        const key = await accountKey()
        if (!key) return cardLang(null)
        const read = createAccountStore(key).read()
        const settings = await Promise.race([read, new Promise<null>((r) => setTimeout(() => r(null), timeoutMs).unref?.())])
        const preferred = settings && typeof settings.settings.preferredLanguage === 'string' ? settings.settings.preferredLanguage : null
        return cardLang(preferred)
    } catch {
        return cardLang(null)
    }
}

/**
 * The one `mustAsk` hook: the conditions ORed (B-922 terminal rule, B-924 non-owner turn, B-924c third-party
 * MCP write in a non-owner turn). Returns the card's 原因 line, or null. Gate 2 sees Very Happy's own tool
 * names, gate 1 the full `mcp__<server>__<tool>` names, so each branch only ever matches its own gate.
 * Exported so tests build the gates exactly as prepareMainAgent does.
 */
export function mainAgentMustAskHook(bashAllowed: () => boolean, isOwner?: () => boolean) {
    return (tool: string, args: Record<string, unknown>): string | null => {
        if (mustAskTerminal(tool, bashAllowed())) return TERMINAL_REASON
        const reason = isOwner ? mainAgentMustAsk(tool, args, isOwner) : mainAgentMustAsk(tool, args)
        if (reason) return mustAskReasonLine(reason)
        return isOwner ? nonOwnerThirdPartyReason(tool, isOwner) : nonOwnerThirdPartyReason(tool)
    }
}

/**
 * B-924c (QA-T P1-B): gate 1 under the mustAsk hook. A call the denylist denies stays denied; otherwise a
 * mustAsk reason turns allow (loose preset, "always allow") into ask, and the approval card carries the
 * reason as its first line. Without a reason gate 1 is exactly the denylist + toolApproval (owner turns).
 */
export function withGate1MustAsk(list: CompiledDenylist, approvalDeps: ToolApprovalDeps, mustAsk: (tool: string, args: Record<string, unknown>) => string | null): Pick<CompiledDenylist, 'denies' | 'decide'> & { ask: ToolAsker } {
    const plain = createToolApproval(approvalDeps)
    const decide = (tool: string): ToolDecision => {
        const base = list.decide(tool)
        if (base === 'deny') return 'deny'
        return mustAsk(tool, {}) ? 'ask' : base
    }
    const ask: ToolAsker = (tool, input) => {
        const reason = mustAsk(tool, input)
        if (!reason) return plain.ask(tool, input)
        const board = approvalDeps.board
        // Same records directory and card checks; only the card face gains the reason line.
        return createToolApproval({ ...approvalDeps, board: board && { ...board, postDecision: (card) => board.postDecision({ ...card, bodyMd: clipBytes(`${reason}\n\n${card.bodyMd}`, 7_900) }) } }).ask(tool, input)
    }
    return { denies: (tool) => decide(tool) === 'deny', decide, ask }
}
const TERMINAL_REASON = '原因：主 agent 的 Bash 已关闭，往终端里发内容等于直接执行命令，所以每次都先问你。'

/** QA P2-2: with Bash off, a terminal is the shell the main agent is not supposed to have — every send asks. */
export function mustAskTerminal(toolName: string, bashAllowed: boolean): boolean {
    return toolName === 'terminal_send' && !bashAllowed
}
