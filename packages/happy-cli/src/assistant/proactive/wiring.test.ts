import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const src = (path: string) => readFileSync(join(__dirname, '..', '..', path), 'utf8')

describe('B-925 wiring', () => {
    it('the daemon feeds turn / state / exit events to the proactive engine and lets B-069 step aside on its machine', () => {
        const run = src('daemon/run.ts')
        expect(run).toContain('onSessionTurnEvent: (sessionId, event) => { turnActivity.apply(sessionId, event); mainAgentProactive?.onTurnEvent(sessionId, event); },')
        expect(run).toContain("if (event === 'needs_input') mainAgentProactive?.onNeedsInput(sessionId);")
        expect(run).toContain('mainAgentProactive?.onSessionExit({')
        expect(run).toContain('if (mainAgentProactive?.active()) return;')
        expect(run).toContain('mainAgentProactive.start();')
        // wake-ups are automated messages, never the owner speaking
        expect(run).toContain("await sendUserMessage(sessionId, persisted, text, 'daemon-auto/main-agent-wake', { localId, sentFrom: 'automation' });")
    })

    it('the main agent wrapper counts woken turns and guards them', () => {
        const server = src('claude/utils/startHappyServer.ts')
        expect(server).toContain('wakeLevel = wakeTurnLevel(sourceIds);')
        expect(server).toContain('wakeUsage?.onTurnStart(sourceIds);')
        expect(server).toContain('void wakeUsage?.onTurnEnd();')
        expect(server).toContain('wakeUsage?.onClaudeLine(body);')
        // One turn origin for the wrapper: B-924's shared tracker (owner or not), plus the wake level.
        expect(server).toContain('turn: () => ({ origin: turnOrigin.current(), wake: wakeLevel }),')
        expect(server).toContain('if (wakeUsage && mainAgentLifecycle) installDispatchLedger(proactiveDispatchLedger(followupsPath(assistantHome())));')
        expect(server).toContain('const mcp = mainAgent ? withOwnerOnlyTools(options?.mainAgentProactive ? withTurnGuards(capped, options.mainAgentProactive) : capped) : server;')
        expect(server).toContain('options!.mainAgent!.gate.wrap(mcp)')
        for (const family of ['registerProjectTools', 'registerIssueTools', 'registerIdleRestartTool', 'registerWrapupTools']) expect(server).toContain(`${family}(mcp,`)
        expect(server).toContain('if (options?.mainAgentProactive) registerFollowupsTool(mcp, { ledgerPath: options.mainAgentProactive.ledgerPath });')
    })

    it('a woken turn is not the owner\'s: it pushes no "ready" notification (B-924 silentMainAgentTurn)', async () => {
        const { classifyTurnOrigin, silentMainAgentTurn } = await import('../turnOrigin')
        const origin = classifyTurnOrigin([{ localId: 'automation-wake-follow-a', sentFrom: 'automation' }])
        expect(origin).not.toBe('owner')
        expect(silentMainAgentTurn(true, origin)).toBe(true)
        const { wakeTurnLevel } = await import('./usage')
        expect(wakeTurnLevel(['automation-wake-report-a', 'automation-wake-follow-b'])).toBe('report')
        expect(wakeTurnLevel(['automation-wake-follow-a', 'web-1'])).toBeNull()
        expect(wakeTurnLevel(undefined)).toBeNull()
    })

    it('the skill and the managed segment carry the proactive conduct', async () => {
        const { MAIN_AGENT_SKILL, renderManagedSegment } = await import('../mainAgentSkill')
        expect(MAIN_AGENT_SKILL).toContain('## 主动性')
        expect(MAIN_AGENT_SKILL).toContain('能自己做的，做完再报')
        expect(MAIN_AGENT_SKILL).toContain('followups_list')
        expect(renderManagedSegment({ skillPaths: [], skillRoots: [] })).toContain('不要问「要不要我去做」')
    })
})
