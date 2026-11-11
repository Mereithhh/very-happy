import { mkdtemp, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { compileOutboundDenylist, isReadOnlyMcpTool, denyPatternToRegExp, isSdkNativePattern, isValidDenyPattern, outboundPreToolUseHook, OUTBOUND_DENY_REASON } from './outboundDenylist'
import { effectiveRisk, keywordRisk, maxRisk, parseRiskClassifierOutput, classifyRisk } from './risk'
import { createDispatchGate, DISPATCH_CARD_KEY_PREFIX, DISPATCH_OPTIONS, DISPATCH_TOOL_NAMES, RECEIPT_MAX_CHARS, cardFaceHash, isReservedCardKey, type BoardItemView, type DispatchBoard } from './dispatchGate'
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
        for (const tool of ['mcp__chat__list_channels', 'mcp__chat__get_history', 'mcp__search__search_web', 'Read', 'Grep', 'Task',
            'mcp__happy__session_send', 'mcp__happy__team_message', 'mcp__happy__owner_board_post', 'mcp__happy__session_message']) {
            expect(list.denies(tool), tool).toBe(false)
        }
    })

    it('QA77 #5: third-party MCP is fail-closed; only clearly read-only tools pass', () => {
        for (const tool of ['mcp__github__create_or_update_file', 'mcp__k8s__kubectl_apply', 'mcp__db__execute_sql', 'mcp__browser__browser_click',
            'mcp__x__tweet', 'mcp__github__get_or_create_label', 'mcp__docs__getAndUpdate', 'mcp__misc__do_something']) {
            expect(list.denies(tool), tool).toBe(true)
        }
        for (const tool of ['mcp__github__list_issues', 'mcp__github__get_file_contents', 'mcp__github__search_code', 'mcp__docs__getPage', 'mcp__db__query_tables', 'mcp__k8s__describe_pod']) {
            expect(list.denies(tool), tool).toBe(false)
            expect(isReadOnlyMcpTool(tool), tool).toBe(true)
        }
        // user patterns still tighten read-only tools
        expect(compileOutboundDenylist(['mcp__github__*']).denies('mcp__github__list_issues')).toBe(true)
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
function fakeBoard(opts: { failPost?: boolean } = {}) {
    const items = new Map<string, BoardItemView>()
    const byId = () => [...items.values()]
    const board: DispatchBoard = {
        postDecision: vi.fn(async (card) => {
            if (opts.failPost) throw new Error('board down')
            const id = `item-${items.size + 1}`
            const item: BoardItemView = { id, key: card.key, state: 'open', ownerChoice: null, resolvedBy: null, title: card.title, bodyMd: card.bodyMd, options: DISPATCH_OPTIONS.map(o => ({ id: o.id, label: o.label })) }
            items.set(card.key, item); return { ...item }
        }),
        findByKey: vi.fn(async (key) => items.get(key) ?? null),
        findById: vi.fn(async (id) => byId().find(i => i.id === id) ?? null),
    }
    const card = (approvalId: string) => items.get(`${DISPATCH_CARD_KEY_PREFIX}${approvalId}`)!
    const choose = (approvalId: string, choice: string, resolvedBy = 'owner') => { const item = card(approvalId); item.state = 'resolved'; item.ownerChoice = choice; item.resolvedBy = resolvedBy }
    return { board, items, choose, card }
}
const text = (result: any) => result.content.map((c: any) => c.text).join('')
const json = (result: any) => JSON.parse(text(result))

async function setup(opts: { board?: boolean; failPost?: boolean; classify?: (p: string) => Promise<string | null>; spawnImpl?: (args: any) => Promise<any> } = {}) {
    const dir = await mkdtemp(join(tmpdir(), 'vh-gate-'))
    const fb = fakeBoard({ failPost: opts.failPost })
    const gate = createDispatchGate({ pendingDir: join(dir, 'pending'), board: opts.board === false ? null : fb.board, classify: opts.classify ?? null, approvalLink: (id) => `https://web.example/session/s1?panel=board （决策 ${id}）` })
    const { tools, mcp } = recorder()
    const spawn = vi.fn(opts.spawnImpl ?? (async (args: any) => ({ content: [{ type: 'text', text: `spawned with ${JSON.stringify(args)}` }], isError: false })))
    const list = vi.fn(async () => ({ content: [{ type: 'text', text: 'list' }], isError: false }))
    const wrapped = gate.wrap(mcp)
    wrapped.registerTool('session_spawn', { description: 'Spawn', inputSchema: { directory: {} as any, prompt: {} as any } }, spawn as any)
    wrapped.registerTool('sessions_list', { description: 'List', inputSchema: {} }, list as any)
    const boardUpdate = vi.fn(async () => ({ content: [{ type: 'text', text: '{"ok":true}' }], isError: false }))
    const boardPost = vi.fn(async () => ({ content: [{ type: 'text', text: '{"ok":true}' }], isError: false }))
    wrapped.registerTool('owner_board_update', { description: 'u', inputSchema: {} }, boardUpdate as any)
    wrapped.registerTool('owner_board_post', { description: 'p', inputSchema: {} }, boardPost as any)
    gate.registerApprovedTool(mcp)
    return { dir, gate, tools, spawn, list, boardUpdate, boardPost, ...fb }
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

    it('draft and drop never dispatch; a non-owner close is refused', async () => {
        const { tools, spawn, choose } = await setup()
        const ids: string[] = []
        for (let i = 0; i < 3; i++) ids.push(json(await tools.get('session_spawn')!.handler({ directory: '/tmp', prompt: `send the report to the team #${i}`, risk: 'external' })).approvalId)
        choose(ids[0], 'draft')
        choose(ids[1], 'drop')
        choose(ids[2], 'approve', 'lead')
        expect(json(await tools.get('dispatch_approved')!.handler({ approvalId: ids[0] })).state).toBe('draft_only')
        expect(json(await tools.get('dispatch_approved')!.handler({ approvalId: ids[1] })).state).toBe('dropped')
        expect(json(await tools.get('dispatch_approved')!.handler({ approvalId: ids[2] })).error).toBe('not_approved')
        expect(json(await tools.get('dispatch_approved')!.handler({ approvalId: '00000000-0000-0000-0000-000000000000' })).error).toBe('approval_not_found')
        expect(json(await tools.get('dispatch_approved')!.handler({ approvalId: '../../etc/passwd' })).error).toBe('approval_not_found')
        expect(spawn).not.toHaveBeenCalled()
    })

    it('QA77 P1: a rewritten card face (swapped labels / softer body) is card_tampered, nothing dispatched', async () => {
        for (const tamper of [
            (c: BoardItemView) => { c.options = [{ id: 'approve', label: '放弃' }, { id: 'draft', label: '只出草稿' }, { id: 'drop', label: '批准执行' }] },
            (c: BoardItemView) => { c.bodyMd = '只在本地整理周报草稿，不对外发送。' },
            (c: BoardItemView) => { c.title = '主 agent 想整理本地周报草稿（none）' },
        ]) {
            const { tools, spawn, choose, card } = await setup()
            const r = json(await tools.get('session_spawn')!.handler({ directory: '/tmp', prompt: 'send the report to D', risk: 'external' }))
            tamper(card(r.approvalId))
            choose(r.approvalId, 'approve')
            expect(json(await tools.get('dispatch_approved')!.handler({ approvalId: r.approvalId })).error).toBe('card_tampered')
            expect(spawn).not.toHaveBeenCalled()
        }
    })

    it('QA77 #2: the main agent cannot post, edit or close a dispatch card through owner_board_*', async () => {
        const { tools, boardUpdate, boardPost, gate } = await setup()
        const r = json(await tools.get('session_spawn')!.handler({ directory: '/tmp', prompt: 'send the report to D', risk: 'external' }))
        const edit = await tools.get('owner_board_update')!.handler({ id: r.boardItemId, title: 'harmless' })
        expect(json(edit).error).toBe('reserved_card')
        expect(boardUpdate).not.toHaveBeenCalled()
        const post = await tools.get('owner_board_post')!.handler({ kind: 'decision', key: `${DISPATCH_CARD_KEY_PREFIX}x`, title: 't' })
        expect(json(post).error).toBe('reserved_card')
        expect(boardPost).not.toHaveBeenCalled()
        await tools.get('owner_board_update')!.handler({ id: 'some-other-item', title: 'fine' })
        expect(boardUpdate).toHaveBeenCalledTimes(1)
        expect(await gate._boardWriteRefusal('owner_board_resolve', { id: r.boardItemId })).toBe('reserved_card')
    })

    it('QA77 #3: no card was posted (board failed) → dispatch_approved refuses, never skips the check', async () => {
        const { tools, spawn, dir } = await setup({ failPost: true })
        const parked = await tools.get('session_spawn')!.handler({ directory: '/tmp', prompt: 'send the report to D', risk: 'external' })
        expect(json(parked).error).toBe('board_unavailable')
        const [file] = (await readdir(join(dir, 'pending'))).filter(n => n.endsWith('.json'))
        const id = file.replace(/\.json$/, '')
        expect(json(await tools.get('dispatch_approved')!.handler({ approvalId: id })).error).toBe('approval_not_found')
        expect(spawn).not.toHaveBeenCalled()
    })

    it('QA77 #4: concurrent dispatch_approved calls dispatch once; a failed dispatch releases the claim', async () => {
        let release!: () => void
        const gateOpen = new Promise<void>(res => { release = res })
        let calls = 0
        const { tools, spawn, choose } = await setup({ spawnImpl: async () => { calls++; await gateOpen; return { content: [{ type: 'text', text: 'spawned' }], isError: false } } })
        const r = json(await tools.get('session_spawn')!.handler({ directory: '/tmp', prompt: 'send the report to D', risk: 'external' }))
        choose(r.approvalId, 'approve')
        const a = tools.get('dispatch_approved')!.handler({ approvalId: r.approvalId })
        const b = tools.get('dispatch_approved')!.handler({ approvalId: r.approvalId })
        await new Promise(res => setTimeout(res, 20)); release()
        const states = [json(await a).state, json(await b).state].sort()
        expect(states).toEqual(['already_dispatched', 'dispatched'])
        expect(calls).toBe(1)
        expect(spawn).toHaveBeenCalledTimes(1)
    })

    it('QA77 #4: a dispatch that fails can be retried (claim rolled back)', async () => {
        let fail = true
        const { tools, spawn, choose } = await setup({ spawnImpl: async () => ({ content: [{ type: 'text', text: fail ? 'daemon down' : 'spawned' }], isError: fail }) })
        const r = json(await tools.get('session_spawn')!.handler({ directory: '/tmp', prompt: 'send the report to D', risk: 'external' }))
        choose(r.approvalId, 'approve')
        expect(json(await tools.get('dispatch_approved')!.handler({ approvalId: r.approvalId })).state).toBe('dispatch_failed')
        fail = false
        expect(json(await tools.get('dispatch_approved')!.handler({ approvalId: r.approvalId })).state).toBe('dispatched')
        expect(spawn).toHaveBeenCalledTimes(2)
    })

    it('QA80 P3: dispatch_approved also takes the card id; the checks stay the same', async () => {
        const { tools, spawn, choose, card } = await setup()
        const a = json(await tools.get('session_spawn')!.handler({ directory: '/tmp', prompt: 'send the report to D', risk: 'external' }))
        choose(a.approvalId, 'approve')
        const done = json(await tools.get('dispatch_approved')!.handler({ boardItemId: a.boardItemId }))
        expect(done).toMatchObject({ state: 'dispatched', approvalId: a.approvalId })
        const b = json(await tools.get('session_spawn')!.handler({ directory: '/tmp', prompt: 'send the report to E', risk: 'external' }))
        card(b.approvalId).bodyMd = 'harmless local work'
        choose(b.approvalId, 'approve')
        expect(json(await tools.get('dispatch_approved')!.handler({ boardItemId: b.boardItemId })).error).toBe('card_tampered')
        expect(json(await tools.get('dispatch_approved')!.handler({ boardItemId: 'not-a-gate-card' })).error).toBe('approval_not_found')
        expect(json(await tools.get('dispatch_approved')!.handler({})).error).toBe('approval_not_found')
        expect(spawn).toHaveBeenCalledTimes(1)
    })

    it('QA80 P3: the reserved prefix matches after trim + lowercase', async () => {
        for (const key of ['main-agent-dispatch:x', '  MAIN-AGENT-DISPATCH:x', 'Main-Agent-Dispatch:y', '\tmain-agent-dispatch:z']) expect(isReservedCardKey(key), key).toBe(true)
        for (const key of ['my-main-agent-dispatch:x', 'main-agent-dispatch', 'issue-review:1', null]) expect(isReservedCardKey(key), String(key)).toBe(false)
        const { tools, boardPost } = await setup()
        expect(json(await tools.get('owner_board_post')!.handler({ kind: 'report', title: 't', key: '  MAIN-AGENT-DISPATCH:x' })).error).toBe('reserved_card')
        expect(boardPost).not.toHaveBeenCalled()
    })

    it('card face hash covers key, title, body and option ids + labels', () => {
        const base: BoardItemView = { id: 'i', key: 'k', state: 'open', ownerChoice: null, resolvedBy: null, title: 't', bodyMd: 'b', options: [{ id: 'approve', label: 'A' }] }
        const h = cardFaceHash(base)
        expect(cardFaceHash({ ...base, state: 'resolved', ownerChoice: 'approve' } as BoardItemView)).toBe(h)
        for (const v of [{ key: 'k2' }, { title: 't2' }, { bodyMd: 'b2' }, { options: [{ id: 'drop', label: 'A' }] }, { options: [{ id: 'approve', label: 'B' }] }]) {
            expect(cardFaceHash({ ...base, ...v })).not.toBe(h)
        }
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
