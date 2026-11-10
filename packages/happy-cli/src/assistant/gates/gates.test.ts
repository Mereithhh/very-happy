import { mkdtemp, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { compileOutboundDenylist, denyPatternToRegExp, isSdkNativePattern, isValidDenyPattern, outboundPreToolUseHook, OUTBOUND_DENY_REASON } from './outboundDenylist'
import { effectiveRisk, keywordRisk, maxRisk, parseRiskClassifierOutput, classifyRisk } from './risk'
import { createDispatchGate, DISPATCH_CARD_KEY_PREFIX, DISPATCH_TOOL_NAMES, RECEIPT_MAX_CHARS, type BoardItemView, type DispatchBoard } from './dispatchGate'
import { mergeMainAgentConfigs, parseMainAgentConfig, decodeKvJson, isValidSkillRoot } from './config'
import { withAssistantDenylist, setAssistantExtraDenied } from '../dispatcherTools'

describe('gate 1: outbound denylist', () => {
    const list = compileOutboundDenylist()

    it('denies outbound-looking MCP tools of any server by verb pattern', () => {
        for (const tool of [
            'mcp__chat__conversations_add_message', 'mcp__mail__send_email', 'mcp__im__reply_to_thread', 'mcp__gh__create_pull_request',
            'mcp__gh__add_issue_comment', 'mcp__npm__publish_package', 'mcp__cloud__deploy_service', 'MCP__Chat__SEND_MESSAGE',
        ]) expect(list.denies(tool), tool).toBe(true)
    })

    it('keeps read tools and Very Happy\'s own server (gate 2 handles it)', () => {
        for (const tool of ['mcp__chat__conversations_history', 'mcp__chat__channels_list', 'mcp__search__web_search', 'Read', 'Grep', 'Task',
            'mcp__happy__session_send', 'mcp__happy__team_message', 'mcp__happy__owner_board_post', 'mcp__happy__session_message']) {
            expect(list.denies(tool), tool).toBe(false)
        }
    })

    it('always denies the B-063 built-ins', () => {
        for (const tool of ['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'bash']) expect(list.denies(tool), tool).toBe(true)
    })

    it('user patterns add, apply to the happy server too, and can never lift a default', () => {
        const custom = compileOutboundDenylist(['mcp__*__*archive*', 'mcp__happy__session_kill', 'mcp__*__*send*', 'bad pattern!', 42])
        expect(custom.denies('mcp__docs__archive_page')).toBe(true)
        expect(custom.denies('mcp__happy__session_kill')).toBe(true)
        expect(custom.denies('mcp__chat__send_message')).toBe(true)
        expect(custom.dropped).toBe(2)
        expect(custom.sdkDisallowed).toEqual(['mcp__happy__session_kill'])
    })

    it('pattern syntax: * only, literal dots, anchored, length/charset checked', () => {
        expect(denyPatternToRegExp('mcp__a.b__x').test('mcp__aXb__x')).toBe(false)
        expect(denyPatternToRegExp('*send*').test('resend_all')).toBe(true)
        expect(denyPatternToRegExp('send').test('resend')).toBe(false)
        expect(isValidDenyPattern('mcp__x__(a|b)')).toBe(false)
        expect(isValidDenyPattern('x'.repeat(129))).toBe(false)
        expect(isSdkNativePattern('mcp__srv__*')).toBe(true)
        expect(isSdkNativePattern('mcp__*__send')).toBe(false)
    })

    it('PreToolUse hook denies with the fixed reason and passes others', async () => {
        const onDeny = vi.fn()
        const hook = outboundPreToolUseHook(list, onDeny)
        const denied = await hook({ hook_event_name: 'PreToolUse', tool_name: 'mcp__chat__conversations_add_message' })
        expect(denied).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: OUTBOUND_DENY_REASON } })
        expect(onDeny).toHaveBeenCalledWith('mcp__chat__conversations_add_message')
        expect(await hook({ hook_event_name: 'PreToolUse', tool_name: 'Read' })).toEqual({ continue: true })
        expect(await hook({ hook_event_name: 'PostToolUse', tool_name: 'mcp__chat__send' })).toEqual({ continue: true })
    })

    it('SDK-native user entries reach disallowedTools for assistant sessions only', () => {
        setAssistantExtraDenied(['mcp__srv__*'])
        try {
            expect(withAssistantDenylist(undefined, true)).toContain('mcp__srv__*')
            expect(withAssistantDenylist(['X'], false)).toEqual(['X'])
        } finally { setAssistantExtraDenied([]) }
    })
})

describe('gate 2: risk', () => {
    it('keyword re-check catches send / publish / production wording', () => {
        expect(keywordRisk('帮我给 A 发消息说今晚的会取消')).toBe('external')
        expect(keywordRisk('回复他一下：收到')).toBe('external')
        expect(keywordRisk('把这份周报发给 A')).toBe('external')
        expect(keywordRisk('send a message to the team channel')).toBe('external')
        expect(keywordRisk('把这个分支 git push 上去')).toBe('external')
        expect(keywordRisk('部署到生产环境')).toBe('production')
        expect(keywordRisk('roll back the deploy')).toBe('production')
        expect(keywordRisk('查一下昨天的日志为什么报错')).toBe('none')
        expect(keywordRisk('写个周报草稿')).toBe('none')
    })

    it('max wins; classifier output is parsed strictly', () => {
        expect(maxRisk('none', 'external', null)).toBe('external')
        expect(maxRisk('production', 'none')).toBe('production')
        expect(parseRiskClassifierOutput('External\n')).toBe('external')
        expect(parseRiskClassifierOutput('I think it is fine')).toBeNull()
        expect(parseRiskClassifierOutput(null)).toBeNull()
    })

    it('a declared none is raised by the classifier, and a failing classifier never lowers', async () => {
        expect((await effectiveRisk({ toolName: 'session_spawn', declared: 'none', payload: 'tell Ada the build is green', classify: async () => 'external' })).level).toBe('external')
        expect((await effectiveRisk({ toolName: 'session_spawn', declared: 'external', payload: 'look at logs', classify: async () => 'none' })).level).toBe('external')
        expect((await effectiveRisk({ toolName: 'session_spawn', declared: 'external', payload: 'x', classify: async () => { throw new Error('boom') } })).level).toBe('external')
        expect(await classifyRisk('t', 'payload', () => new Promise(() => {}), 10)).toBeNull()
    })
})

type Registered = { name: string; config: any; handler: (args: any, extra?: any) => Promise<any> }
function recorder() {
    const tools = new Map<string, Registered>()
    return { tools, mcp: { registerTool: ((name: string, config: any, handler: any) => { tools.set(name, { name, config, handler }) }) as any } }
}
function fakeBoard() {
    const items = new Map<string, BoardItemView & { title: string; bodyMd: string }>()
    const board: DispatchBoard = {
        postDecision: vi.fn(async (card) => { const id = `item-${items.size + 1}`; items.set(card.key, { id, key: card.key, state: 'open', ownerChoice: null, resolvedBy: null, title: card.title, bodyMd: card.bodyMd }); return { id } }),
        findByKey: vi.fn(async (key) => items.get(key) ?? null),
    }
    const choose = (approvalId: string, choice: string, resolvedBy = 'owner') => { const item = items.get(`${DISPATCH_CARD_KEY_PREFIX}${approvalId}`)!; item.state = 'resolved'; item.ownerChoice = choice; item.resolvedBy = resolvedBy }
    return { board, items, choose }
}
const text = (result: any) => result.content.map((c: any) => c.text).join('')
const json = (result: any) => JSON.parse(text(result))

async function setup(opts: { board?: boolean; classify?: (p: string) => Promise<string | null> } = {}) {
    const dir = await mkdtemp(join(tmpdir(), 'vh-gate-'))
    const fb = fakeBoard()
    const gate = createDispatchGate({ pendingDir: join(dir, 'pending'), board: opts.board === false ? null : fb.board, classify: opts.classify ?? null, approvalLink: (id) => `https://web.example/session/s1?panel=board （决策 ${id}）` })
    const { tools, mcp } = recorder()
    const spawn = vi.fn(async (args: any) => ({ content: [{ type: 'text', text: `spawned with ${JSON.stringify(args)}` }], isError: false }))
    const list = vi.fn(async () => ({ content: [{ type: 'text', text: 'list' }], isError: false }))
    const wrapped = gate.wrap(mcp)
    wrapped.registerTool('session_spawn', { description: 'Spawn', inputSchema: { directory: {} as any, prompt: {} as any } }, spawn as any)
    wrapped.registerTool('sessions_list', { description: 'List', inputSchema: {} }, list as any)
    gate.registerApprovedTool(mcp)
    return { dir, gate, tools, spawn, list, ...fb }
}

describe('gate 2: dispatch gate', () => {
    it('adds a required risk to dispatch tools only', async () => {
        const { tools } = await setup()
        expect(Object.keys(tools.get('session_spawn')!.config.inputSchema)).toContain('risk')
        expect(Object.keys(tools.get('sessions_list')!.config.inputSchema)).not.toContain('risk')
        expect(DISPATCH_TOOL_NAMES).toEqual(expect.arrayContaining(['session_spawn', 'session_send', 'terminal_send', 'team_delegate', 'team_message', 'session_message', 'automation_create', 'automation_update', 'lead_delegate', 'lead_message']))
    })

    it('missing risk is refused; none runs the tool without the risk argument', async () => {
        const { tools, spawn } = await setup()
        const missing = await tools.get('session_spawn')!.handler({ directory: '/tmp', prompt: 'look at logs' })
        expect(missing.isError).toBe(true)
        expect(json(missing).error).toBe('risk_required')
        expect(spawn).not.toHaveBeenCalled()
        await tools.get('session_spawn')!.handler({ directory: '/tmp', prompt: '查一下日志', risk: 'none' })
        expect(spawn).toHaveBeenCalledWith({ directory: '/tmp', prompt: '查一下日志' }, undefined)
    })

    it('「帮我给 A 发消息」declared none: not dispatched, a decision card instead; approve dispatches with the link', async () => {
        const { tools, spawn, board, items, choose, dir } = await setup()
        const parked = await tools.get('session_spawn')!.handler({ directory: '/tmp', prompt: '帮我给 A 发消息说今晚的会取消', risk: 'none' })
        const r = json(parked)
        expect(r).toMatchObject({ ok: true, state: 'awaiting_decision', risk: 'external' })
        expect(text(parked).length).toBeLessThanOrEqual(RECEIPT_MAX_CHARS)
        expect(spawn).not.toHaveBeenCalled()
        expect(board.postDecision).toHaveBeenCalledTimes(1)
        const card = items.get(`${DISPATCH_CARD_KEY_PREFIX}${r.approvalId}`)!
        expect(card.title).toContain('external')
        expect(card.bodyMd).toContain('session_spawn')
        expect((await readdir(join(dir, 'pending')))).toContain(`${r.approvalId}.json`)

        const early = await tools.get('dispatch_approved')!.handler({ approvalId: r.approvalId })
        expect(json(early).error).toBe('awaiting_decision')
        expect(spawn).not.toHaveBeenCalled()

        choose(r.approvalId, 'approve')
        const done = await tools.get('dispatch_approved')!.handler({ approvalId: r.approvalId })
        expect(json(done)).toMatchObject({ ok: true, state: 'dispatched', choice: 'approve' })
        expect(spawn).toHaveBeenCalledTimes(1)
        const sent = spawn.mock.calls[0][0] as any
        expect(sent.prompt.startsWith(`本任务已获批：https://web.example/session/s1?panel=board （决策 ${r.boardItemId}）`)).toBe(true)
        expect(sent.prompt).toContain('帮我给 A 发消息')
        expect(sent).not.toHaveProperty('risk')

        const again = await tools.get('dispatch_approved')!.handler({ approvalId: r.approvalId })
        expect(json(again).state).toBe('already_dispatched')
        expect(spawn).toHaveBeenCalledTimes(1)
    })

    it('draft adds the do-not-send prefix; drop and non-owner closes never dispatch', async () => {
        const { tools, spawn, choose } = await setup()
        const ids: string[] = []
        for (let i = 0; i < 3; i++) ids.push(json(await tools.get('session_spawn')!.handler({ directory: '/tmp', prompt: `send the report to the team #${i}`, risk: 'external' })).approvalId)
        choose(ids[0], 'draft')
        choose(ids[1], 'drop')
        choose(ids[2], 'approve', 'lead')
        expect(json(await tools.get('dispatch_approved')!.handler({ approvalId: ids[0] })).state).toBe('dispatched')
        expect((spawn.mock.calls[0][0] as any).prompt).toMatch(/^本任务已获批，但只出草稿、不得发送或发布：/)
        expect(json(await tools.get('dispatch_approved')!.handler({ approvalId: ids[1] })).state).toBe('dropped')
        expect(json(await tools.get('dispatch_approved')!.handler({ approvalId: ids[2] })).error).toBe('not_approved')
        expect(json(await tools.get('dispatch_approved')!.handler({ approvalId: '00000000-0000-0000-0000-000000000000' })).error).toBe('approval_not_found')
        expect(json(await tools.get('dispatch_approved')!.handler({ approvalId: '../../etc/passwd' })).error).toBe('approval_not_found')
        expect(spawn).toHaveBeenCalledTimes(1)
    })

    it('tampered pending args are refused (approve A, run B)', async () => {
        const { tools, spawn, choose, dir } = await setup()
        const r = json(await tools.get('session_spawn')!.handler({ directory: '/tmp', prompt: 'reply to the thread: ok', risk: 'external' }))
        const path = join(dir, 'pending', `${r.approvalId}.json`)
        const pending = JSON.parse(await readFile(path, 'utf8'))
        pending.args.prompt = 'something else entirely'
        await (await import('node:fs/promises')).writeFile(path, JSON.stringify(pending))
        choose(r.approvalId, 'approve')
        expect(json(await tools.get('dispatch_approved')!.handler({ approvalId: r.approvalId })).error).toBe('approval_mismatch')
        expect(spawn).not.toHaveBeenCalled()
    })

    it('no board: non-none is refused, never run directly', async () => {
        const { tools, spawn } = await setup({ board: false })
        const result = await tools.get('session_spawn')!.handler({ directory: '/tmp', prompt: 'deploy to production', risk: 'production' })
        expect(json(result).error).toBe('board_unavailable')
        expect(spawn).not.toHaveBeenCalled()
    })

    it('the classifier raises a cleanly-worded external task', async () => {
        const classify = vi.fn(async () => 'external')
        const { tools, spawn } = await setup({ classify })
        const result = await tools.get('session_spawn')!.handler({ directory: '/tmp', prompt: 'Let Ada know the build is green', risk: 'none' })
        expect(json(result).state).toBe('awaiting_decision')
        expect(classify).toHaveBeenCalledTimes(1)
        expect(spawn).not.toHaveBeenCalled()
    })
})

describe('config', () => {
    it('parses, drops invalid items one by one, and unions sources', () => {
        const kv = parseMainAgentConfig({ skillRoots: ['~/skills', 'relative/path', '/abs'], deniedTools: ['mcp__*__*archive*', 'no spaces allowed'] })
        expect(kv).toEqual({ skillRoots: ['~/skills', '/abs'], deniedTools: ['mcp__*__*archive*'], dropped: 2 })
        const merged = mergeMainAgentConfigs(kv, parseMainAgentConfig({ skillRoots: ['/abs', '/other'], deniedTools: ['MCP__*__*ARCHIVE*'] }))
        expect(merged.skillRoots).toEqual(['~/skills', '/abs', '/other'])
        expect(merged.deniedTools).toEqual(['mcp__*__*archive*'])
        expect(parseMainAgentConfig('nope')).toEqual({ skillRoots: [], deniedTools: [], dropped: 0 })
        expect(decodeKvJson(Buffer.from(JSON.stringify({ v: 1 })).toString('base64'))).toEqual({ v: 1 })
        expect(decodeKvJson('%%%')).toBeNull()
        expect(isValidSkillRoot('~')).toBe(true)
        expect(isValidSkillRoot('/a\nb')).toBe(false)
    })
})
