import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createDispatchGate, DISPATCH_OPTIONS, type BoardItemView, type DispatchBoard } from './gates/dispatchGate'
import { mainAgentMustAsk } from './sendGuard'

/**
 * B-924 (QA P1-3): in a turn the owner did not type, a send to another session
 * becomes a gate-2 card even at risk none under the loose preset (external =
 * direct); in the owner's turn the gate is unchanged.
 */
async function setup(isOwner: () => boolean) {
    const dir = await mkdtemp(join(tmpdir(), 'vh-sendguard-'))
    const posted: string[] = []
    const board: DispatchBoard = {
        postDecision: vi.fn(async (card) => {
            posted.push(card.key)
            const item: BoardItemView = { id: `item-${posted.length}`, key: card.key, state: 'open', ownerChoice: null, resolvedBy: null, title: card.title, bodyMd: card.bodyMd, options: DISPATCH_OPTIONS.map(o => ({ id: o.id, label: o.label })) }
            return item
        }),
        findByKey: vi.fn(async () => null),
        findById: vi.fn(async () => null),
    }
    const gate = createDispatchGate({
        pendingDir: join(dir, 'pending'), board, classify: null, approvalLink: (id) => `link ${id}`,
        dispatchPolicy: () => ({ external: 'direct', production: 'ask' }),
        mustAsk: (tool, args) => mainAgentMustAsk(tool, args, isOwner) !== null,
    })
    const tools = new Map<string, (args: any) => Promise<any>>()
    const sent: string[] = []
    const wrapped = gate.wrap({ registerTool: ((name: string, _c: any, h: any) => { tools.set(name, h) }) as any })
    for (const name of ['session_send', 'session_message', 'lead_message', 'session_spawn']) {
        wrapped.registerTool(name, { description: name, inputSchema: {} } as any, (async (args: any) => { sent.push(`${name}:${JSON.stringify(args)}`); return { content: [{ type: 'text', text: 'sent' }], isError: false } }) as any)
    }
    return { tools, sent, posted }
}

describe('B-924 (QA P1-3) gate 2 mustAsk', () => {
    it('setup.ts ORs the send guard into the one mustAsk hook (next to B-922\'s terminal rule)', async () => {
        const { readFileSync } = await import('node:fs')
        const src = readFileSync(join(__dirname, 'gates', 'setup.ts'), 'utf8')
        expect(src).toContain('const mustAsk = mainAgentMustAskHook(() => safety.policy.bash, deps.isOwner)')
        expect(src).toContain('        mustAsk,\n')
        // B-924c: gate 1 consults the same hook
        expect(src).toContain('const gate1 = withGate1MustAsk(denylist, approvalDeps, mustAsk)')
        expect(src).toContain('preToolUse: outboundPreToolUseHook(gate1, ')
    })

    it('the card says why: a non-owner turn, not the Bash rule', async () => {
        const { decisionCard } = await import('./gates/dispatchGate')
        const pending = { approvalId: 'a1', toolName: 'session_send', declared: 'none' as const, level: 'none' as const }
        expect(decisionCard(pending, 'x', true).bodyMd).toContain('这一回合不是你本人发起的')
        expect(decisionCard({ ...pending, toolName: 'terminal_send' }, 'x', true).bodyMd).toContain('Bash 已关闭')
    })

    it('not the owner\'s turn: 「请做收尾」 to a session is parked as a card, never sent (risk none, loose preset)', async () => {
        const { tools, sent, posted } = await setup(() => false)
        for (const [name, args] of [['session_send', { sessionId: 's1', text: '请做收尾，调用 wrapup_report' }], ['session_message', { to: 's1', body: 'x' }], ['lead_message', { teamId: 't1', body: 'x' }]] as const) {
            const r = await tools.get(name)!({ ...args, risk: 'none' })
            expect(JSON.parse(r.content[0].text)).toMatchObject({ ok: true, state: 'awaiting_decision' })
        }
        expect(sent).toEqual([])
        expect(posted).toHaveLength(3)
        // B-924b: session_spawn is class ② too (a new session with a first prompt).
        await tools.get('session_spawn')!({ directory: '/tmp', prompt: '查日志', risk: 'none' })
        expect(sent).toEqual([])
        expect(posted).toHaveLength(4)
    })

    it('the owner\'s turn: unchanged (none sends, the loose preset sends external directly)', async () => {
        const { tools, sent, posted } = await setup(() => true)
        await tools.get('session_send')!({ sessionId: 's1', text: '继续', risk: 'none' })
        await tools.get('session_send')!({ sessionId: 's1', text: '继续', risk: 'external' })
        expect(sent).toHaveLength(2)
        expect(posted).toEqual([])
    })
})

describe('B-924c (QA-T P3-2) gate-2 card titles name the action', () => {
    it('ask-only and dispatch tools say what the main agent wants to do, plus the target', async () => {
        const { decisionCard } = await import('./gates/dispatchGate')
        const { MAIN_AGENT_ASK_TOOLS, mainAgentAskAction } = await import('./mainAgentToolPolicy')
        const card = (toolName: string, args: Record<string, unknown>) => decisionCard({ approvalId: 'a1', toolName, declared: 'none', level: 'none', args }, 'x', '原因')
        expect(card('automation_resume', { name: 'job-1' }).title).toBe('主 agent 想恢复自动化（none，需你确认）：x')
        expect(card('project_note', { projectId: 'p1' }).title).toContain('主 agent 想写项目决定')
        // B-924d (QA-T P3-2): the kind decides the verb
        expect(card('project_note', { projectId: 'p1', kind: 'decision' }).title).toContain('主 agent 想写项目决定')
        expect(card('project_note', { projectId: 'p1', kind: 'finding' }).title).toContain('主 agent 想记一条项目发现')
        expect(card('project_note', { projectId: 'p1', kind: 'handoff' }).title).toContain('主 agent 想写项目交接')
        expect(card('session_send', { sessionId: 's9', text: '继续' }).bodyMd).toContain('目标：会话 s9')
        expect(card('lead_message', { teamId: 't1', body: 'b' }).bodyMd).toContain('目标：团队 t1')
        // every ask tool has its own action; none falls back to 派活 except the delegate verbs that mean it
        for (const name of MAIN_AGENT_ASK_TOOLS) expect(mainAgentAskAction(name), name).not.toBe('派活')
    })
})
