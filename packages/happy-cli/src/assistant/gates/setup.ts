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
 * defaults: a broken KV or file never lifts gate 1.
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { AttentionClient } from '@/attention/client'
import { assistantHome } from '../bootstrap'
import { installMainAgentSkill, renderManagedSegment, writeManagedSegment } from '../mainAgentSkill'
import { expandHome, loadMainAgentConfig, type MainAgentConfig } from './config'
import { compileOutboundDenylist, outboundPreToolUseHook, type CompiledDenylist } from './outboundDenylist'
import { createDispatchGate, DISPATCH_OPTIONS, type DispatchBoard, type DispatchGate } from './dispatchGate'
import type { OneShotRunner } from './risk'

export const MAIN_AGENT_GATES_CAPABILITY = 'main-agent-gates-v1'

export type MainAgentRuntime = {
    config: MainAgentConfig
    denylist: CompiledDenylist
    /** SDK `hooks.PreToolUse` callback. */
    preToolUse: ReturnType<typeof outboundPreToolUseHook>
    /** Existing skillRoots, for SDK `additionalDirectories`. */
    extraDirectories: string[]
    gate: DispatchGate
}

export function attentionDispatchBoard(client: AttentionClient, sessionId: () => string): DispatchBoard {
    return {
        async postDecision(card) {
            const { item } = await client.post({
                sessionId: sessionId(), source: 'agent', kind: 'decision',
                title: card.title, bodyMd: card.bodyMd, key: card.key, requestId: card.requestId,
                options: DISPATCH_OPTIONS.map(o => ({ ...o })),
            })
            return { id: item.id }
        },
        async findByKey(key) {
            const { items } = await client.list({ sessionId: sessionId(), state: 'all', limit: 200 })
            const item = items.find(i => i.key === key)
            return item ? { id: item.id, key: item.key, state: item.state, ownerChoice: item.ownerChoice, resolvedBy: item.resolvedBy } : null
        },
    }
}

export async function prepareMainAgent(deps: {
    kvGet: (key: string) => Promise<{ value: string } | null>
    board: DispatchBoard | null
    classify: OneShotRunner | null
    approvalLink: (boardItemId: string) => string
    home?: string
    assistantHomeDir?: string
    log?: (line: string) => void
}): Promise<MainAgentRuntime> {
    const home = deps.home ?? homedir()
    const aHome = deps.assistantHomeDir ?? assistantHome()
    const config = await loadMainAgentConfig({ assistantHome: aHome, kvGet: deps.kvGet }).catch(() => ({ skillRoots: [], deniedTools: [], dropped: 0 }))
    if (config.dropped > 0) deps.log?.(`[main-agent] dropped ${config.dropped} invalid config item(s)`)
    const denylist = compileOutboundDenylist(config.deniedTools)
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
        pendingDir: join(aHome, 'pending-dispatch'),
        board: deps.board,
        classify: deps.classify,
        approvalLink: deps.approvalLink,
        log: deps.log,
    })
    return {
        config,
        denylist,
        preToolUse: outboundPreToolUseHook(denylist, (tool) => deps.log?.(`[main-agent gate] denied ${tool}`)),
        // The managed skill lives outside the assistant home: mount its directory too, or every
        // read of the handbook asks for permission in the default mode (seen in the isolated probe).
        extraDirectories: [...(skillPath ? [dirname(skillPath)] : []), ...roots.filter(r => r.exists).map(r => r.path)],
        gate,
    }
}
