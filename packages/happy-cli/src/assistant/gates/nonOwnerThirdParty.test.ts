/**
 * B-924c (QA-T on B-924b, P1-B): in a turn the owner did not type, gate 1 asks for every third-party MCP
 * outbound / production / write tool, whatever the safety preset (the default loose one included) and the
 * "always allow" list. The owner's own turn is unchanged.
 *
 * Transport level: a fake `qa` MCP server with `send_message` behind a real MCP client; each call goes
 * through the PreToolUse hook prepareMainAgent builds (as the Claude SDK runs it) and reaches the
 * server only when the hook lets it.
 */
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { prepareMainAgent } from './setup'
import { type BoardItemView, type DispatchBoard } from './dispatchGate'
import { nonOwnerThirdPartyReason, thirdPartyToolClass } from '../sendGuard'

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64')

async function fakeQaServer() {
    const sent: string[] = []
    const server = new McpServer({ name: 'qa', version: '1' })
    server.registerTool('send_message', { description: 'send a chat message', inputSchema: { channel: z.string(), text: z.string() } },
        async (args) => { sent.push(`${args.channel}:${args.text}`); return { content: [{ type: 'text', text: 'sent' }] } })
    server.registerTool('list_channels', { description: 'list', inputSchema: {} }, async () => ({ content: [{ type: 'text', text: '#general' }] }))
    const [a, b] = InMemoryTransport.createLinkedPair()
    await server.connect(a)
    const client = new Client({ name: 'main-agent', version: '1' })
    await client.connect(b)
    return { sent, client }
}

function recordingBoard() {
    const items = new Map<string, BoardItemView>()
    const board: DispatchBoard = {
        postDecision: vi.fn(async (card) => {
            const item: BoardItemView = { id: `item-${items.size + 1}`, key: card.key, state: 'open', ownerChoice: null, resolvedBy: null, title: card.title, bodyMd: card.bodyMd, options: (card.options ?? []).map((o: { id: string; label: string }) => ({ id: o.id, label: o.label })) }
            items.set(item.id, item); return { ...item }
        }),
        findByKey: vi.fn(async (key) => [...items.values()].find(i => i.key === key) ?? null),
        findById: vi.fn(async (id) => items.get(id) ?? null),
    }
    return { board, items }
}

async function harness(safety: Record<string, unknown> | null) {
    let owner = false
    const { board, items } = recordingBoard()
    const rt = await prepareMainAgent({
        kvGet: async () => safety ? { value: b64({ v: 1, safety }) } : null,
        board, classify: null, approvalLink: (id) => id,
        home: await mkdtemp(join(tmpdir(), 'vh-924c-home-')), assistantHomeDir: await mkdtemp(join(tmpdir(), 'vh-924c-a-')),
        isOwner: () => owner,
    })
    const qa = await fakeQaServer()
    /** One model tool call as the SDK runs it: PreToolUse first, the MCP server only on continue. */
    const call = async (tool: string, args: Record<string, unknown>) => {
        const verdict = await rt.preToolUse({ hook_event_name: 'PreToolUse', tool_name: `mcp__qa__${tool}`, tool_input: args })
        if (!('continue' in verdict) && verdict.hookSpecificOutput.permissionDecision !== 'allow') return { denied: verdict.hookSpecificOutput.permissionDecisionReason }
        const r = await qa.client.callTool({ name: tool, arguments: args })
        return { result: (r.content as Array<{ text: string }>)[0].text }
    }
    return { rt, qa, call, board, items, setOwner: (v: boolean) => { owner = v } }
}

describe('B-924c (QA-T P1-B) third-party MCP writes in a non-owner turn always ask', () => {
    it('default loose preset: qa.send_message in a non-owner turn posts a card and does not send; in the owner\'s turn it sends', async () => {
        const h = await harness(null)
        expect(h.rt.safety.safety.preset).toBe('loose')
        const args = { channel: '#general', text: 'S5-OUTBOUND' }
        const r = await h.call('send_message', args)
        expect(r.denied).toContain('等 Owner 批准')
        expect(h.qa.sent).toEqual([])
        expect(h.items.size).toBe(1)
        const card = [...h.items.values()][0]
        expect(card.title).toBe('主 agent 想调用 mcp__qa__send_message')
        expect((card.bodyMd ?? '').split('\n')[0]).toContain('原因：这一回合不是你本人发起的')
        expect(card.bodyMd ?? '').toContain('对外发送类工具一律先问你')
        // Reads stay direct in a non-owner turn.
        expect(await h.call('list_channels', {})).toEqual({ result: '#general' })
        // Owner approves the card → the same call runs once.
        const item = [...h.items.values()][0]; item.state = 'resolved'; item.ownerChoice = 'once'; item.resolvedBy = 'owner'
        expect(await h.call('send_message', args)).toEqual({ result: 'sent' })
        expect(h.qa.sent).toEqual(['#general:S5-OUTBOUND'])
        // The owner's own turn: loose = direct, no card.
        h.setOwner(true)
        expect(await h.call('send_message', { channel: '#general', text: 'owner-typed' })).toEqual({ result: 'sent' })
        expect(h.qa.sent).toEqual(['#general:S5-OUTBOUND', '#general:owner-typed'])
        expect(h.items.size).toBe(1)
    })

    it('"always allow" does not lift it in a non-owner turn; a hard deny stays a deny', async () => {
        const h = await harness({ v: 1, preset: 'loose', overrides: {}, allowedTools: ['mcp__qa__send_message'] })
        expect((await h.call('send_message', { channel: '#x', text: 'y' })).denied).toContain('等 Owner 批准')
        expect(h.qa.sent).toEqual([])
        h.setOwner(true)
        expect(await h.call('send_message', { channel: '#x', text: 'y' })).toEqual({ result: 'sent' })
        const strict = await harness({ v: 1, preset: 'strict' })
        expect((await strict.call('send_message', { channel: '#x', text: 'y' })).denied).toContain('主 agent 不能直接对外发送')
        expect(strict.items.size).toBe(0)
    })

    it('covers outbound, production and other third-party writes; Very Happy\'s own tools, built-ins and reads are untouched', () => {
        expect(thirdPartyToolClass('mcp__qa__send_message')).toBe('outbound')
        expect(thirdPartyToolClass('mcp__chat__conversations_add_message')).toBe('outbound')
        expect(thirdPartyToolClass('mcp__cloud__deploy_service')).toBe('production')
        expect(thirdPartyToolClass('mcp__k8s__kubectl_apply')).toBe('production')
        expect(thirdPartyToolClass('mcp__db__execute_sql')).toBe('thirdPartyWrite')
        expect(thirdPartyToolClass('mcp__misc__do_something')).toBe('thirdPartyWrite')
        for (const t of ['mcp__github__list_issues', 'mcp__docs__getPage', 'mcp__happy__session_send', 'mcp__happy__owner_board_post', 'Read', 'WebFetch']) expect(thirdPartyToolClass(t), t).toBeNull()
        expect(nonOwnerThirdPartyReason('mcp__db__execute_sql', () => false)).toContain('第三方写入类')
        expect(nonOwnerThirdPartyReason('mcp__db__execute_sql', () => true)).toBeNull()
    })
})
