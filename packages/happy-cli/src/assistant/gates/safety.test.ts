import { mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { PRESET_POLICIES, type MainAgentSafetyPolicy } from '@slopus/happy-wire'
import { compileOutboundDenylist, outboundPreToolUseHook, OUTBOUND_DENY_REASON, TOOL_APPROVAL_UNAVAILABLE_REASON, DEFAULT_OUTBOUND_DENY_PATTERNS } from './outboundDenylist'
import { createDispatchGate, isReservedCardKey, cardFaceHash, type BoardItemView, type DispatchBoard } from './dispatchGate'
import { createToolApproval, TOOL_APPROVAL_OPTIONS, toolCardKey } from './toolApproval'
import { parseMainAgentConfig, persistAllowedTool, resolveMainAgentSafety, loadMainAgentConfig } from './config'
import { prepareMainAgent } from './setup'
import { happyHomeCandidates, protectedPathsFor, PROTECTED_PATH_REASON, BROAD_SEARCH_REASON } from './protectedPaths'
import { withAssistantDenylist, setAssistantBuiltinsAllowed, assistantBuiltinsAllowedBy } from '../dispatcherTools'
import type { KvIo } from '../mainAgentPointer'

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64')
const unb64 = (value: string) => JSON.parse(Buffer.from(value, 'base64').toString('utf8'))

/** Every tool name the B-916c tests exercise, plus a few more of each class. */
const SAMPLE_TOOLS = [
    'Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'bash', 'Read', 'Grep', 'Task', 'WebFetch',
    'mcp__happy__session_send', 'mcp__happy__team_message', 'mcp__happy__owner_board_post', 'mcp__happy__session_kill',
    'mcp__chat__conversations_add_message', 'mcp__mail__send_email', 'mcp__im__reply_to_thread', 'mcp__gh__create_pull_request',
    'mcp__gh__add_issue_comment', 'mcp__npm__publish_package', 'mcp__cloud__deploy_service', 'MCP__Chat__SEND_MESSAGE',
    'mcp__github__create_or_update_file', 'mcp__k8s__kubectl_apply', 'mcp__db__execute_sql', 'mcp__browser__browser_click',
    'mcp__x__tweet', 'mcp__github__get_or_create_label', 'mcp__docs__getAndUpdate', 'mcp__misc__do_something',
    'mcp__github__list_issues', 'mcp__github__get_file_contents', 'mcp__github__search_code', 'mcp__docs__getPage',
    'mcp__db__query_tables', 'mcp__k8s__describe_pod', 'mcp__cloud__list_deployments', 'mcp__docs__get_share_link',
    'mcp__docs__archive_page', 'mcp__gh__merge_pull_request', 'mcp__gh__get_release', 'mcp__db__drop_table',
]

describe('B-922 gate 1 under the safety presets', () => {
    it('strict = B-916c, item for item (regression)', () => {
        const extra = ['mcp__*__*archive*', 'mcp__happy__session_kill']
        const before = compileOutboundDenylist(extra) // the B-916c call shape (no safety argument)
        const strict = compileOutboundDenylist(extra, { policy: PRESET_POLICIES.strict, allowedTools: ['mcp__mail__send_email', 'Bash'] })
        for (const tool of SAMPLE_TOOLS) {
            expect(strict.denies(tool), tool).toBe(before.denies(tool))
            expect(strict.decide(tool), tool).not.toBe('ask')
        }
        expect(strict.patterns).toEqual(before.patterns)
        expect(strict.sdkDisallowed).toEqual(before.sdkDisallowed)
        expect(strict.patterns.slice(0, DEFAULT_OUTBOUND_DENY_PATTERNS.length)).toEqual([...DEFAULT_OUTBOUND_DENY_PATTERNS])
    })

    it('strict hook output is the B-916c deny, word for word', async () => {
        const hook = outboundPreToolUseHook(compileOutboundDenylist([], { policy: PRESET_POLICIES.strict }), undefined, async () => 'allow')
        expect(await hook({ hook_event_name: 'PreToolUse', tool_name: 'mcp__chat__send_message', tool_input: { text: 'hi' } }))
            .toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: OUTBOUND_DENY_REASON } })
    })

    it('standard: outbound / production / third-party writes ask; reads, own tools pass; built-ins and user patterns deny', () => {
        const list = compileOutboundDenylist(['mcp__*__*archive*'], { policy: PRESET_POLICIES.standard })
        for (const tool of ['mcp__mail__send_email', 'mcp__gh__create_pull_request', 'mcp__cloud__deploy_service', 'mcp__k8s__kubectl_apply', 'mcp__db__execute_sql', 'mcp__misc__do_something', 'mcp__docs__get_share_link', 'mcp__gh__get_release'])
            expect(list.decide(tool), tool).toBe('ask')
        for (const tool of ['mcp__github__list_issues', 'mcp__cloud__list_deployments', 'mcp__happy__session_send', 'Read', 'WebFetch'])
            expect(list.decide(tool), tool).toBe('allow')
        for (const tool of ['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'mcp__docs__archive_page'])
            expect(list.decide(tool), tool).toBe('deny')
    })

    it('loose: third-party writes and sends pass; production-class tools still ask', () => {
        const list = compileOutboundDenylist([], { policy: PRESET_POLICIES.loose })
        for (const tool of ['mcp__mail__send_email', 'mcp__gh__add_issue_comment', 'mcp__github__create_or_update_file', 'mcp__browser__browser_click', 'mcp__gh__merge_pull_request'])
            expect(list.decide(tool), tool).toBe('allow')
        for (const tool of ['mcp__cloud__deploy_service', 'mcp__npm__publish_package', 'mcp__k8s__kubectl_apply', 'mcp__db__drop_table', 'mcp__gh__create_release'])
            expect(list.decide(tool), tool).toBe('ask')
        expect(list.decide('Bash')).toBe('deny')
    })

    it('allowedTools turn an ask into allow, never a deny', () => {
        const std = compileOutboundDenylist(['mcp__mail__*'], { policy: PRESET_POLICIES.standard, allowedTools: ['mcp__chat__send_message', 'mcp__mail__send_email', 'Bash'] })
        expect(std.decide('mcp__chat__send_message')).toBe('allow')
        expect(std.decide('MCP__CHAT__SEND_MESSAGE')).toBe('allow')
        expect(std.decide('mcp__chat__send_file')).toBe('ask')
        expect(std.decide('mcp__mail__send_email')).toBe('deny') // user pattern
        expect(std.decide('Bash')).toBe('deny')
        std.allowAlways('mcp__chat__send_file')
        expect(std.decide('mcp__chat__send_file')).toBe('allow')
    })

    it('built-ins open only through bash / fileEdits, and only for the SDK list the main agent sets', () => {
        const policy: MainAgentSafetyPolicy = { ...PRESET_POLICIES.loose, bash: true }
        const list = compileOutboundDenylist([], { policy })
        expect(list.decide('Bash')).toBe('allow')
        expect(list.decide('Edit')).toBe('deny')
        expect(assistantBuiltinsAllowedBy({ bash: false, fileEdits: true })).toEqual(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
        setAssistantBuiltinsAllowed(assistantBuiltinsAllowedBy(policy))
        try {
            expect(withAssistantDenylist(undefined, true)).not.toContain('Bash')
            expect(withAssistantDenylist(undefined, true)).toContain('Edit')
            // per-message denials still stick
            expect(withAssistantDenylist(['Bash'], true)).toContain('Bash')
        } finally { setAssistantBuiltinsAllowed([]) }
        expect(withAssistantDenylist(undefined, true)).toContain('Bash')
    })
})

describe('B-922 config: account decides, local file only tightens, unreadable = strict', () => {
    it('local tightens per item and its allowedTools never count', () => {
        const kv = { safety: { v: 1, preset: 'loose', allowedTools: ['mcp__a__send'] } }
        const local = { safety: { v: 1, preset: 'loose', overrides: { outbound: 'deny', dispatchExternal: 'ask', bash: true }, allowedTools: ['mcp__a__deploy'] } }
        const r = resolveMainAgentSafety(kv, local)
        expect(r.policy).toEqual({ ...PRESET_POLICIES.loose, outbound: 'deny', dispatchExternal: 'ask' })
        expect(r.allowedTools).toEqual(['mcp__a__send'])
        // a local file cannot loosen a strict account
        expect(resolveMainAgentSafety({ safety: { v: 1, preset: 'strict' } }, { safety: { v: 1, preset: 'loose' } }).policy).toEqual(PRESET_POLICIES.strict)
    })

    it('no section = loose (the default); failed request or garbage value = strict', async () => {
        const aHome = await mkdtemp(join(tmpdir(), 'vh-safety-'))
        expect((await loadMainAgentConfig({ assistantHome: aHome, kvGet: async () => null })).safety?.policy).toEqual(PRESET_POLICIES.loose)
        expect((await loadMainAgentConfig({ assistantHome: aHome, kvGet: async () => { throw new Error('503') } })).safety?.policy).toEqual(PRESET_POLICIES.strict)
        expect((await loadMainAgentConfig({ assistantHome: aHome, kvGet: async () => ({ value: '%%%' }) })).safety?.policy).toEqual(PRESET_POLICIES.strict)
        const future = await loadMainAgentConfig({ assistantHome: aHome, kvGet: async () => ({ value: b64({ v: 1, safety: { v: 2, preset: 'loose', network: 'open' } }) }) })
        expect(future.safety?.policy).toEqual(PRESET_POLICIES.strict)
        expect(future.safety?.failedClosed).toBe(true)
    })

    it('an older CLI (B-916c parse) ignores the section: same strict denylist', () => {
        const raw = { v: 1, deniedTools: [], safety: { v: 1, preset: 'loose', overrides: { bash: true }, allowedTools: ['mcp__mail__send_email'] } }
        const old = compileOutboundDenylist(parseMainAgentConfig(raw).deniedTools)
        expect(old.denies('mcp__mail__send_email')).toBe(true)
        expect(old.denies('Bash')).toBe(true)
    })

    it('prepareMainAgent wires preset → gate 1 hook and gate 2 policy', async () => {
        const aHome = await mkdtemp(join(tmpdir(), 'vh-safety-prep-'))
        const home = await mkdtemp(join(tmpdir(), 'vh-safety-home-'))
        const strict = await prepareMainAgent({ kvGet: async () => ({ value: b64({ v: 1, safety: { v: 1, preset: 'strict' } }) }), board: null, classify: null, approvalLink: (id) => id, home, assistantHomeDir: aHome })
        expect(await strict.preToolUse({ hook_event_name: 'PreToolUse', tool_name: 'mcp__chat__send_message', tool_input: {} }))
            .toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: OUTBOUND_DENY_REASON } })
        const dflt = await prepareMainAgent({ kvGet: async () => null, board: null, classify: null, approvalLink: (id) => id, home, assistantHomeDir: aHome })
        expect(dflt.safety.safety.preset).toBe('loose')
        expect(await dflt.preToolUse({ hook_event_name: 'PreToolUse', tool_name: 'mcp__chat__send_message', tool_input: {} })).toEqual({ continue: true })
        const std = await prepareMainAgent({ kvGet: async () => ({ value: b64({ v: 1, safety: { v: 1, preset: 'standard' } }) }), board: null, classify: null, approvalLink: (id) => id, home, assistantHomeDir: aHome })
        expect(std.safety.safety.preset).toBe('standard')
        // ask without a board fails closed with its own reason
        expect(await std.preToolUse({ hook_event_name: 'PreToolUse', tool_name: 'mcp__chat__send_message', tool_input: {} }))
            .toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: TOOL_APPROVAL_UNAVAILABLE_REASON } })
    })
})

function toolBoard() {
    const items = new Map<string, BoardItemView>()
    let n = 0
    const board: DispatchBoard = {
        postDecision: vi.fn(async (card) => {
            const id = `item-${++n}`
            const item: BoardItemView = { id, key: card.key, state: 'open', ownerChoice: null, resolvedBy: null, title: card.title, bodyMd: card.bodyMd, options: (card.options ?? []).map((o: { id: string; label: string }) => ({ id: o.id, label: o.label })) }
            items.set(id, item); return { ...item }
        }),
        findByKey: vi.fn(async (key) => [...items.values()].find(i => i.key === key) ?? null),
        findById: vi.fn(async (id) => items.get(id) ?? null),
    }
    const last = () => [...items.values()].at(-1)!
    const choose = (choice: string, resolvedBy = 'owner', item = last()) => { item.state = 'resolved'; item.ownerChoice = choice; item.resolvedBy = resolvedBy }
    return { board, items, last, choose }
}

async function askSetup(policy: MainAgentSafetyPolicy = PRESET_POLICIES.standard) {
    const dir = await mkdtemp(join(tmpdir(), 'vh-tool-ask-'))
    const tb = toolBoard()
    const list = compileOutboundDenylist([], { policy })
    const persist = vi.fn(async () => 'written')
    const approval = createToolApproval({ pendingDir: join(dir, 'pending-tool'), board: tb.board, allowAlways: (t) => list.allowAlways(t), persistAlways: persist })
    const hook = outboundPreToolUseHook(list, undefined, approval.ask)
    const call = (tool_input: Record<string, unknown>, tool_name = 'mcp__chat__send_message') => hook({ hook_event_name: 'PreToolUse', tool_name, tool_input })
    return { dir, ...tb, list, persist, hook, call }
}
const reasonOf = (out: any): string | null => out?.hookSpecificOutput?.permissionDecisionReason ?? null

describe('B-922 gate 1 ask: card → owner → exactly that call', () => {
    it('posts a card (tool + argument summary, three options) and tells the model to wait', async () => {
        const s = await askSetup()
        const out = await s.call({ channel: 'C1', text: 'build is green' })
        expect(reasonOf(out)).toContain('等 Owner 批准')
        expect(reasonOf(out)).toContain('item-1')
        const card = s.last()
        expect(card.key).toMatch(/^main-agent-tool:[0-9a-f-]{36}:mcp__chat__send_message$/)
        expect(card.title).toBe('主 agent 想调用 mcp__chat__send_message')
        expect(card.bodyMd).toContain('"text": "build is green"')
        expect(card.options).toEqual(TOOL_APPROVAL_OPTIONS.map(o => ({ id: o.id, label: o.label })))
        expect(isReservedCardKey(card.key)).toBe(true)
        // still open: same card, no second post
        expect(reasonOf(await s.call({ text: 'build is green', channel: 'C1' }))).toContain('item-1')
        expect(s.board.postDecision).toHaveBeenCalledTimes(1)
    })

    it('approve once: that call runs once; the same call again asks again', async () => {
        const s = await askSetup()
        await s.call({ text: 'hi' })
        s.choose('once')
        expect(await s.call({ text: 'hi' })).toEqual({ continue: true })
        const again = await s.call({ text: 'hi' })
        expect(reasonOf(again)).toContain('item-2')
        expect(s.board.postDecision).toHaveBeenCalledTimes(2)
        expect(s.persist).not.toHaveBeenCalled()
    })

    it('the approval binds the arguments: a different call gets its own card', async () => {
        const s = await askSetup()
        await s.call({ text: 'hi' })
        s.choose('once')
        expect(reasonOf(await s.call({ text: 'hi!' }))).toContain('item-2')
        expect(await s.call({ text: 'hi' })).toEqual({ continue: true })
    })

    it('always: runs, joins allowedTools (memory + persisted), no more cards for that tool', async () => {
        const s = await askSetup()
        await s.call({ text: 'hi' })
        s.choose('always')
        expect(await s.call({ text: 'hi' })).toEqual({ continue: true })
        expect(s.persist).toHaveBeenCalledWith('mcp__chat__send_message')
        expect(await s.call({ text: 'other text' })).toEqual({ continue: true })
        expect(s.board.postDecision).toHaveBeenCalledTimes(1)
        // another tool still asks
        expect(reasonOf(await s.call({ to: 'a' }, 'mcp__mail__send_email'))).toContain('item-2')
    })

    it('deny: refused with the owner\'s answer; the next identical call asks afresh', async () => {
        const s = await askSetup()
        await s.call({ text: 'hi' })
        s.choose('deny')
        expect(reasonOf(await s.call({ text: 'hi' }))).toContain('Owner 拒绝')
        expect(reasonOf(await s.call({ text: 'hi' }))).toContain('item-2')
    })

    it('closed by anyone but the owner, or a rewritten card face, approves nothing', async () => {
        const s = await askSetup()
        await s.call({ text: 'hi' })
        s.choose('once', 'lead')
        expect(reasonOf(await s.call({ text: 'hi' }))).toContain('item-2')
        s.choose('once')
        s.last().bodyMd = 'harmless'
        expect(cardFaceHash(s.last())).not.toBe('')
        expect(reasonOf(await s.call({ text: 'hi' }))).toContain('item-3')
    })

    it('concurrent identical calls: one approval, one run (O_EXCL)', async () => {
        const s = await askSetup()
        await s.call({ text: 'hi' })
        s.choose('once')
        const outs = await Promise.all([s.call({ text: 'hi' }), s.call({ text: 'hi' }), s.call({ text: 'hi' })])
        expect(outs.filter(o => 'continue' in o).length).toBe(1)
        expect((await readdir(join(s.dir, 'pending-tool'))).filter(f => f.endsWith('.inflight')).length).toBe(1)
    })

    it('a board that throws fails closed', async () => {
        const s = await askSetup()
        vi.mocked(s.board.postDecision).mockRejectedValueOnce(new Error('down'))
        expect(reasonOf(await s.call({ text: 'hi' }))).toBe(TOOL_APPROVAL_UNAVAILABLE_REASON)
    })

    it('card key carries approval id + tool (server checks "always" grants by it)', () => {
        expect(toolCardKey('0b8c2b5e-1111-4222-8333-944445555666', 'mcp__x__y')).toBe('main-agent-tool:0b8c2b5e-1111-4222-8333-944445555666:mcp__x__y')
    })
})

describe('B-922 gate 2 policy', () => {
    async function gateWith(policy: { external: 'ask' | 'direct'; production: 'ask' | 'direct' }) {
        const dir = await mkdtemp(join(tmpdir(), 'vh-gate2-policy-'))
        const tb = toolBoard()
        const gate = createDispatchGate({ pendingDir: join(dir, 'pending'), board: tb.board, classify: null, approvalLink: (id) => id, dispatchPolicy: () => policy })
        const spawn = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'spawned' }], isError: false }))
        const tools = new Map<string, any>()
        const wrapped = gate.wrap({ registerTool: ((name: string, config: any, handler: any) => { tools.set(name, handler) }) as any })
        wrapped.registerTool('session_spawn', { description: 'Spawn', inputSchema: {} } as any, spawn as any)
        return { tools, spawn, tb }
    }

    it('direct for external dispatches at once; production still parks', async () => {
        const g = await gateWith({ external: 'direct', production: 'ask' })
        const ext = await g.tools.get('session_spawn')({ directory: '/r', prompt: 'reply to them in the thread', risk: 'external' })
        expect(ext.content[0].text).toBe('spawned')
        expect(g.spawn).toHaveBeenCalledWith({ directory: '/r', prompt: 'reply to them in the thread' }, undefined)
        const prod = await g.tools.get('session_spawn')({ directory: '/r', prompt: 'deploy to production', risk: 'none' })
        expect(JSON.parse(prod.content[0].text).state).toBe('awaiting_decision')
        expect(g.spawn).toHaveBeenCalledTimes(1)
    })

    it('default (ask, ask) = B-916c: external parks', async () => {
        const g = await gateWith({ external: 'ask', production: 'ask' })
        const ext = await g.tools.get('session_spawn')({ directory: '/r', prompt: 'x', risk: 'external' })
        expect(JSON.parse(ext.content[0].text).state).toBe('awaiting_decision')
        expect(g.spawn).not.toHaveBeenCalled()
    })
})

describe('B-922 persistAllowedTool', () => {
    function memKv(initial: unknown, conflicts = 0): KvIo & { value: () => any; writes: number } {
        let value: string | null = initial === undefined ? null : b64(initial)
        let version = initial === undefined ? -1 : 3
        let left = conflicts
        const io = {
            writes: 0,
            async get() { return value === null ? null : { value, version } },
            async set(_key: string, next: string, v: number) {
                if (left-- > 0) { version++; return 'conflict' as const }
                if (v !== version) return 'conflict' as const
                io.writes++; value = next; version++; return 'ok' as const
            },
            value: () => value ? unb64(value) : null,
        }
        return io
    }

    it('creates the section at the default preset; keeps every other field', async () => {
        const kv = memKv({ v: 1, skillRoots: ['~/s'], quietHours: [1, 2] })
        expect(await persistAllowedTool(kv, 'mcp__chat__send_message', () => 7)).toBe('written')
        expect(kv.value()).toEqual({ v: 1, skillRoots: ['~/s'], quietHours: [1, 2], safety: { v: 1, preset: 'loose', allowedTools: ['mcp__chat__send_message'] }, updatedAt: 7 })
    })

    it('appends to an existing section, idempotent, retries one conflict', async () => {
        const kv = memKv({ v: 1, safety: { v: 1, preset: 'loose', overrides: { bash: true }, allowedTools: ['mcp__a__b'] } }, 1)
        expect(await persistAllowedTool(kv, 'mcp__chat__send_message')).toBe('written')
        expect(kv.value().safety).toEqual({ v: 1, preset: 'loose', overrides: { bash: true }, allowedTools: ['mcp__a__b', 'mcp__chat__send_message'] })
        expect(await persistAllowedTool(kv, 'MCP__CHAT__SEND_MESSAGE')).toBe('unchanged')
    })

    it('never rewrites a section it does not understand', async () => {
        const kv = memKv({ v: 1, safety: { v: 2, preset: 'whatever' } })
        expect(await persistAllowedTool(kv, 'mcp__chat__send_message')).toBe('unsupported')
        expect(kv.writes).toBe(0)
        expect(await persistAllowedTool(kv, 'mcp__*__*')).toBe('unsupported')
    })

    it('QA-U r2 P3-1: a server 422 (no live always card) is "refused", a network failure "unavailable"', async () => {
        const failing = (message: string): KvIo => ({ async get() { return null }, async set() { throw new Error(message) } })
        expect(await persistAllowedTool(failing('kv 422'), 'mcp__chat__send_message')).toBe('refused')
        expect(await persistAllowedTool(failing('kv 503'), 'mcp__chat__send_message')).toBe('unavailable')
        expect(await persistAllowedTool(failing('fetch failed'), 'mcp__chat__send_message')).toBe('unavailable')
    })
})

it('B-922: local config file written by anyone cannot add allowedTools', async () => {
    const aHome = await mkdtemp(join(tmpdir(), 'vh-safety-local-'))
    await writeFile(join(aHome, 'config.json'), JSON.stringify({ safety: { v: 1, preset: 'loose', allowedTools: ['mcp__cloud__deploy_service'] } }))
    const cfg = await loadMainAgentConfig({ assistantHome: aHome, kvGet: async () => null })
    expect(cfg.safety?.allowedTools).toEqual([])
    expect(cfg.safety?.policy).toEqual(PRESET_POLICIES.loose)
})

describe('B-922: owner_board_* cannot post, edit or close a gate-1 approval card (main-agent-tool:*)', () => {
    const TOOL_KEY = 'main-agent-tool:0b8c2b5e-1111-4222-8333-944445555666:mcp__chat__send_message'

    it('the reserved prefix covers it, case- and whitespace-insensitively', () => {
        for (const key of [TOOL_KEY, `  ${TOOL_KEY.toUpperCase()}`, '\tMain-Agent-Tool:x:y']) expect(isReservedCardKey(key), key).toBe(true)
        for (const key of ['my-main-agent-tool:x', 'main-agent-tools:x', 'main-agent-tool']) expect(isReservedCardKey(key), key).toBe(false)
    })

    it('the main agent\'s board tools (gate wrap) refuse it by key and by id; other cards pass', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'vh-tool-reserved-'))
        const tb = toolBoard()
        const gate = createDispatchGate({ pendingDir: join(dir, 'pending'), board: tb.board, classify: null, approvalLink: (id) => id })
        const tools = new Map<string, any>()
        const wrapped = gate.wrap({ registerTool: ((name: string, _c: any, handler: any) => { tools.set(name, handler) }) as any })
        const inner = vi.fn(async () => ({ content: [{ type: 'text' as const, text: '{"ok":true}' }], isError: false }))
        for (const name of ['owner_board_post', 'owner_board_update', 'owner_board_resolve']) wrapped.registerTool(name, { description: name, inputSchema: {} } as any, inner as any)
        // a real gate-1 card on the board (posted by toolApproval, not by the dispatch gate)
        const approval = createToolApproval({ pendingDir: join(dir, 'pending-tool'), board: tb.board, allowAlways: () => {} })
        await approval.ask('mcp__chat__send_message', { text: 'hi' })
        const card = tb.last()
        expect(card.key!.startsWith('main-agent-tool:')).toBe(true)
        const err = (r: any) => JSON.parse(r.content[0].text).error
        expect(err(await tools.get('owner_board_post')({ kind: 'decision', title: 't', key: ` ${card.key!.toUpperCase()}` }))).toBe('reserved_card')
        expect(err(await tools.get('owner_board_update')({ id: card.id, title: 'softer' }))).toBe('reserved_card')
        expect(err(await tools.get('owner_board_resolve')({ id: card.id, outcome: 'done' }))).toBe('reserved_card')
        expect(inner).not.toHaveBeenCalled()
        await tools.get('owner_board_post')({ kind: 'report', title: 't', key: 'topic' })
        expect(inner).toHaveBeenCalledTimes(1)
    })

    it('the shared owner_board_* tools refuse it too', async () => {
        const { registerOwnerBoardTools } = await import('@/attention/tools')
        const calls: string[] = []
        const board = {
            post: async () => { calls.push('post'); return { id: 'n', created: true } },
            update: async (input: { id: string }) => { calls.push(`update:${input.id}`); return {} },
            resolve: async (input: { id: string }) => { calls.push(`resolve:${input.id}`); return {} },
            list: async () => ({ items: [{ id: 't1', key: TOOL_KEY }, { id: 't2', key: 'topic' }] }),
        } as any
        const tools = new Map<string, any>()
        registerOwnerBoardTools({ registerTool: (name: string, _c: unknown, handler: any) => { tools.set(name, handler) } } as any, board)
        expect((await tools.get('owner_board_post')({ kind: 'decision', title: 't', key: TOOL_KEY, request_id: 'req-p', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] })).isError).toBe(true)
        expect((await tools.get('owner_board_update')({ id: 't1', title: 'softer', request_id: 'req-u' })).isError).toBe(true)
        expect((await tools.get('owner_board_resolve')({ id: 't1', outcome: 'done', request_id: 'req-r' })).isError).toBe(true)
        expect((await tools.get('owner_board_update')({ id: 't2', title: 'ok', request_id: 'req-u2' })).isError).toBe(false)
        expect(calls).toEqual(['update:t2'])
    })
})

describe('QA P2-2: HAPPY_HOME is closed to the main agent file tools (read allowlist only), every preset', () => {
    async function happyHome() {
        const { mkdir, symlink } = await import('node:fs/promises')
        const root = await mkdtemp(join(tmpdir(), 'vh-protect-'))
        const hh = join(root, '.happy')
        const a = join(hh, 'assistant')
        await mkdir(join(a, 'memory', 'journal'), { recursive: true })
        await mkdir(join(a, 'wrapup-cards'), { recursive: true })
        await mkdir(join(hh, 'main-agent-approvals', 'pending-tool'), { recursive: true })
        await mkdir(join(hh, 'uploads', 'chat', 's1'), { recursive: true })
        await writeFile(join(a, 'CLAUDE.md'), '# role')
        await writeFile(join(a, 'memory', 'personal.md'), 'likes tea')
        await writeFile(join(a, 'memory', 'journal', '2026-11-11.md'), 'did things')
        await writeFile(join(a, 'followups.json'), '{}')
        await writeFile(join(a, 'wrapup-cards', 'c.json'), '{}')
        await writeFile(join(hh, 'access.key'), '{"token":"t","secret":"s"}')
        await writeFile(join(hh, 'uploads', 'chat', 's1', 'pic.png'), 'x')
        await symlink(join(hh, 'access.key'), join(a, 'memory', 'innocent.md'))   // a link inside the allowlist pointing out
        await symlink(join(a, 'memory'), join(root, 'mem-link'))                  // a link outside pointing in (fine to read)
        return { root, hh, cwd: a }
    }

    it('read: CLAUDE.md, memory/** (journal too) and chat uploads only', async () => {
        const { root, hh, cwd } = await happyHome()
        const p = protectedPathsFor(hh, { home: root })
        for (const fp of ['CLAUDE.md', 'memory/personal.md', join(cwd, 'memory', 'journal', '2026-11-11.md'), '~/.happy/assistant/memory/personal.md', join(hh, 'uploads', 'chat', 's1', 'pic.png'), join(root, 'mem-link', 'personal.md'), join(root, 'elsewhere.md')])
            expect(p.check('Read', { file_path: fp }, cwd), fp).toBeNull()
        for (const fp of ['followups.json', 'wrapup-cards/c.json', join(cwd, 'pending-dispatch', 'x.json'), join(cwd, 'precheck-1.json'), join(cwd, 'handoff-new.json'),
            '../access.key', '~/.happy/access.key', join(hh, 'agent.key'), join(hh, 'daemon.state.json'), join(hh, 'settings.json'), join(hh, 'settings-approvals', 'a.json'),
            join(hh, 'main-agent-approvals', 'pending-tool', 'abc.json'), join(hh, 'teams', 'x'), 'memory/innocent.md', 'memory/../followups.json', join(cwd, 'x.inflight')])
            expect(p.check('Read', { file_path: fp }, cwd), fp).toBe(PROTECTED_PATH_REASON)
    })

    it('write: nothing under HAPPY_HOME, not even the allowlist', async () => {
        const { root, hh, cwd } = await happyHome()
        const p = protectedPathsFor(hh, { home: root })
        for (const [tool, input] of [
            ['Write', { file_path: 'memory/personal.md' }], ['Edit', { file_path: 'CLAUDE.md' }], ['MultiEdit', { file_path: 'followups.json' }],
            ['Write', { file_path: join(hh, 'main-agent-approvals', 'pending-tool', 'forged.json') }], ['NotebookEdit', { notebook_path: join(hh, 'x.ipynb') }],
            ['Write', { file_path: join(root, 'mem-link', 'personal.md') }],
        ] as const) expect(p.check(tool, input, cwd), `${tool} ${JSON.stringify(input)}`).toBe(PROTECTED_PATH_REASON)
        expect(p.check('Write', { file_path: join(root, 'notes.md') }, cwd)).toBeNull()
    })

    it('search: Grep / Glob only inside the allowlist; anything covering HAPPY_HOME is refused', async () => {
        const { root, hh, cwd } = await happyHome()
        const p = protectedPathsFor(hh, { home: root })
        for (const input of [{ pattern: 'tea', path: 'memory' }, { pattern: 'tea', path: join(cwd, 'memory', 'journal') }, { pattern: 'x', path: join(root, 'skills') }])
            expect(p.check('Grep', input, cwd), JSON.stringify(input)).toBeNull()
        for (const input of [{ pattern: 'memory/**/*.md' }, { pattern: '**/*.md', path: 'memory' }, { pattern: `${cwd}/memory/*.md` }, { pattern: '*.md', path: join(root, 'skills') }])
            expect(p.check('Glob', input, cwd), JSON.stringify(input)).toBeNull()
        for (const [tool, input] of [
            ['Grep', { pattern: 'x' }],                                   // no path = the assistant home (followups.json, wrapup-cards/)
            ['Grep', { pattern: 'token', path: hh }], ['Grep', { pattern: 'token', path: '~' }], ['Grep', { pattern: 'token', path: '/' }],
            ['Grep', { pattern: 'token', path: '~/.happy' }], ['Grep', { pattern: 'x', path: 'wrapup-cards' }], ['Grep', { pattern: 'x', path: 'memory/..' }],
            ['Grep', { pattern: 'x', path: join(hh, 'main-agent-approvals') }],
            ['Glob', { pattern: '*.json' }], ['Glob', { pattern: '../*.key' }], ['Glob', { pattern: 'memory/../*.json' }],
            ['Glob', { pattern: `${hh}/*.key` }], ['Glob', { pattern: '~/.happy/**' }], ['Glob', { pattern: '**/*.key', path: '/' }],
            ['Glob', { pattern: `${hh}/main-agent-approvals/**` }],
        ] as const) expect(p.check(tool, input, cwd), `${tool} ${JSON.stringify(input)}`).toBe(BROAD_SEARCH_REASON)
    })

    it('HAPPY_HOME_DIR counts too, and the hook refuses before any preset decision', async () => {
        const { root, hh, cwd } = await happyHome()
        const other = await mkdtemp(join(tmpdir(), 'vh-protect-env-'))
        await writeFile(join(other, 'access.key'), 'k')
        const p = protectedPathsFor(happyHomeCandidates(hh, { HAPPY_HOME_DIR: other }), { home: root })
        expect(p.check('Read', { file_path: join(other, 'access.key') }, cwd)).toBe(PROTECTED_PATH_REASON)
        for (const policy of [PRESET_POLICIES.strict, PRESET_POLICIES.standard, PRESET_POLICIES.loose]) {
            const hook = outboundPreToolUseHook(compileOutboundDenylist([], { policy }), undefined, async () => 'allow', protectedPathsFor(hh, { home: root }))
            expect(await hook({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: join(hh, 'access.key') }, cwd }))
                .toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: PROTECTED_PATH_REASON } })
            expect(await hook({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: join(cwd, 'memory', 'personal.md') }, cwd })).toEqual({ continue: true })
        }
    })

    it('prepareMainAgent keeps approval records outside the assistant home and wires the guard', async () => {
        const { root, hh } = await happyHome()
        const aHome = join(hh, 'assistant')
        const tb = toolBoard()
        const rt = await prepareMainAgent({ kvGet: async () => ({ value: b64({ v: 1, safety: { v: 1, preset: 'standard' } }) }), board: tb.board, classify: null, approvalLink: (id) => id, home: root, assistantHomeDir: aHome, happyHomeDir: hh })
        await rt.preToolUse({ hook_event_name: 'PreToolUse', tool_name: 'mcp__chat__send_message', tool_input: { text: 'hi' }, cwd: aHome })
        const files = await readdir(join(hh, 'main-agent-approvals', 'pending-tool'))
        expect(files.some((f) => f.endsWith('.json'))).toBe(true)
        expect((await readdir(aHome)).some((f) => f.startsWith('pending-'))).toBe(false)
        expect(reasonOf(await rt.preToolUse({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: join(aHome, 'followups.json') }, cwd: aHome }))).toBe(PROTECTED_PATH_REASON)
        expect(await rt.preToolUse({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: join(aHome, 'memory', 'personal.md') }, cwd: aHome })).toEqual({ continue: true })
    })
})

describe('QA P2-2: terminal_send always asks while Bash is off', () => {
    async function gate(mustAsk?: (t: string, a: Record<string, unknown>) => boolean) {
        const dir = await mkdtemp(join(tmpdir(), 'vh-term-'))
        const tb = toolBoard()
        const g = createDispatchGate({ pendingDir: join(dir, 'p'), board: tb.board, classify: null, approvalLink: (id) => id, mustAsk, dispatchPolicy: () => ({ external: 'direct', production: 'direct' }) })
        const send = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'sent' }], isError: false }))
        const tools = new Map<string, any>()
        g.wrap({ registerTool: ((n: string, _c: any, h: any) => { tools.set(n, h) }) as any }).registerTool('terminal_send', { description: 't', inputSchema: {} } as any, send as any)
        return { tools, send, tb }
    }

    it('forced: risk none (and even a "direct" policy) parks with the reason on the card', async () => {
        const g = await gate((t) => t === 'terminal_send')
        const r = await g.tools.get('terminal_send')({ terminalId: 't1', text: 'ls ~/.happy\n', risk: 'none' })
        expect(JSON.parse(r.content[0].text).state).toBe('awaiting_decision')
        expect(g.send).not.toHaveBeenCalled()
        expect(g.tb.last().bodyMd).toContain('Bash 已关闭')
        const ext = await g.tools.get('terminal_send')({ terminalId: 't1', text: 'git push\n', risk: 'external' })
        expect(JSON.parse(ext.content[0].text).state).toBe('awaiting_decision')
    })

    it('not forced (Bash on): the risk rules apply as before', async () => {
        const g = await gate(() => false)
        expect((await g.tools.get('terminal_send')({ terminalId: 't1', text: 'ls\n', risk: 'none' })).content[0].text).toBe('sent')
    })

    it('prepareMainAgent sets mustAsk exactly when Bash is off, in every preset', async () => {
        for (const [safety, forced] of [
            [{ v: 1, preset: 'strict' }, true], [{ v: 1, preset: 'standard' }, true], [{ v: 1, preset: 'loose' }, true],
            [{ v: 1, preset: 'loose', overrides: { bash: true } }, false],
        ] as const) {
            const aHome = await mkdtemp(join(tmpdir(), 'vh-term-prep-'))
            const tb = toolBoard()
            const rt = await prepareMainAgent({ kvGet: async () => ({ value: b64({ v: 1, safety }) }), board: tb.board, classify: null, approvalLink: (id) => id, home: aHome, assistantHomeDir: aHome })
            const send = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'sent' }], isError: false }))
            const tools = new Map<string, any>()
            rt.gate.wrap({ registerTool: ((n: string, _c: any, h: any) => { tools.set(n, h) }) as any }).registerTool('terminal_send', { description: 't', inputSchema: {} } as any, send as any)
            await tools.get('terminal_send')({ terminalId: 't1', text: 'ls\n', risk: 'none' })
            expect(send.mock.calls.length === 0, JSON.stringify(safety)).toBe(forced)
        }
    })
})

describe('QA P3', () => {
    it('a KV value that is JSON but not an object reads as strict (same rule as the server)', async () => {
        const aHome = await mkdtemp(join(tmpdir(), 'vh-arr-'))
        for (const v of [[], 'loose', 42, true]) {
            const cfg = await loadMainAgentConfig({ assistantHome: aHome, kvGet: async () => ({ value: b64(v) }) })
            expect(cfg.safety?.policy, JSON.stringify(v)).toEqual(PRESET_POLICIES.strict)
            expect(cfg.safety?.failedClosed).toBe(true)
        }
    })

    it('gate-1 cards follow the account language; option ids never change', async () => {
        const { cardLang, toolApprovalCard } = await import('./toolApproval')
        expect(cardLang('zh-Hans')).toBe('zh')
        expect(cardLang('en', 'zh_CN.UTF-8')).toBe('en')
        expect(cardLang(null, 'zh_CN.UTF-8')).toBe('zh')
        expect(cardLang(null, '')).toBe('en')
        const en = toolApprovalCard('0b8c2b5e-1111-4222-8333-944445555666', 'mcp__x__send', { a: 1 }, 'f'.repeat(64), 'en')
        expect(en.title).toBe('The main agent wants to call mcp__x__send')
        expect(en.options.map((o) => o.id)).toEqual(['once', 'always', 'deny'])
        expect(en.options.map((o) => o.label)).toEqual(['Approve once', 'Always allow this tool', 'Decline'])
        const zh = toolApprovalCard('0b8c2b5e-1111-4222-8333-944445555666', 'mcp__x__send', { a: 1 }, 'f'.repeat(64), 'zh')
        expect(zh.options.map((o) => o.id)).toEqual(['once', 'always', 'deny'])
        expect(zh.title).toBe('主 agent 想调用 mcp__x__send')
    })
})
