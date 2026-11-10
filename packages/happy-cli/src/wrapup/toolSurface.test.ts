/**
 * B-915: the wrap-up / handoff tools reach every managed runner the B-496 way
 * (Claude in-process + toolNames, Codex bridge forward without a new literal
 * registerTool(, pi via tools/list), and every runner's turn end can trigger
 * the archive after a confirmed handoff. Source assertions verified with
 * scripts/dev/mutation-check.mjs.
 */
import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { WRAPUP_TOOL_NAMES } from '@slopus/happy-wire'
import { executeWrapupTool, registerWrapupTools } from './tools'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/^\s*\/\/.*$/gm, '')

describe('wrap-up tool surface', () => {
    it('is registered in-process for managed Claude and advertised in toolNames', () => {
        const source = read('../claude/utils/startHappyServer.ts')
        expect(source).toContain('if (wrapup) registerWrapupTools(mcp, wrapup);')
        expect(source).toContain('...WRAPUP_TOOL_NAMES,')
        expect(source).toContain("wrapupTracker.onUserMessage({ localId: event.localId });")
        expect(source).toContain("client.on('agent-ready', onAgentReady);")
        expect(source).toContain('(metadata.capabilities ?? []), ATTENTION_SESSION_CAPABILITY, WRAPUP_SESSION_CAPABILITY])')
    })
    it('is forwarded by the Codex stdio bridge without new literal registrations', () => {
        const source = read('../codex/happyMcpStdioBridge.ts')
        expect(source).toContain('registerWrapupTools(server, (name, args) => forwardTeam(name, args as Record<string, unknown>));')
        expect(source.match(/registerTool\(/g)).toHaveLength(3)
    })
    it('every runner signals the end of a turn with ready (the archive trigger outside Claude)', () => {
        expect(read('../api/apiSession.ts')).toContain("if (event.type === 'ready') {")
        expect(read('../codex/runCodex.ts')).toContain("session.sendSessionEvent({ type: 'ready' });")
        expect(read('../agent/acp/runAcp.ts')).toContain("session.sendSessionEvent({ type: 'ready' });")
    })
    it('keeps the documented matrix in sync', () => {
        const channels = readFileSync(new URL('../../../../docs/channels.md', import.meta.url), 'utf8')
        for (const name of WRAPUP_TOOL_NAMES) expect(channels).toContain(name)
        expect(channels).toContain('very-happy sessions wrapup')
    })
    it('registers the four tools; a failed handoff is a tool error', async () => {
        const handlers = new Map<string, (args: unknown) => Promise<{ isError: boolean; content: Array<{ text: string }> }>>()
        registerWrapupTools({ registerTool: ((name: string, _spec: unknown, fn: never) => { handlers.set(name, fn) }) as never }, async (name) => name === 'handoff_send' ? { delivery: 'failed' } : { ok: true })
        expect([...handlers.keys()]).toEqual([...WRAPUP_TOOL_NAMES])
        expect((await handlers.get('handoff_send')!({})).isError).toBe(true)
        expect((await handlers.get('wrapup_report')!({})).isError).toBe(false)
    })
    it('validates input and refuses handing off to itself', async () => {
        const tracker = { report: vi.fn(), handoff: vi.fn() }
        const context = { selfId: () => 's1', tracker }
        await expect(executeWrapupTool('wrapup_report', { summary: 'x' }, context)).rejects.toThrow(/can_close/)
        await expect(executeWrapupTool('handoff_send', { to: 's1', summary: 'x' }, context)).rejects.toThrow(/this session/)
        const requestWrapup = vi.fn(async () => [])
        await executeWrapupTool('session_wrapup', { session_ids: ['a1'], template: 'T', request_id: 'r' }, { ...context, requestWrapup })
        expect(requestWrapup).toHaveBeenCalledWith(['a1'], { template: 'T', requestId: 'r', self: 's1' })
        const requestHandoff = vi.fn(async () => ({ sessionId: 'a1', state: 'queued' as const }))
        await executeWrapupTool('session_handoff', { from: 'a1', to: 'b1', archive_after: true }, { ...context, requestHandoff })
        expect(requestHandoff).toHaveBeenCalledWith({ from: 'a1', to: 'b1', archiveAfter: true })
        expect(tracker.report).not.toHaveBeenCalled()
    })
    it('B-916 contract: session_id alias and an ok flag on every receipt', async () => {
        const context = { selfId: () => 's1', tracker: { report: vi.fn(), handoff: vi.fn() } }
        const requestWrapup = vi.fn(async () => [{ sessionId: 'a1', state: 'queued' as const }, { sessionId: 'b1', state: 'error' as const, error: 'archived' }])
        expect(await executeWrapupTool('session_wrapup', { session_id: 'b1', session_ids: ['a1'] }, { ...context, requestWrapup })).toEqual({
            results: [{ ok: true, sessionId: 'a1', state: 'queued' }, { ok: false, sessionId: 'b1', state: 'error', error: 'archived' }],
        })
        expect(requestWrapup).toHaveBeenCalledWith(['a1', 'b1'], { self: 's1' })
        await expect(executeWrapupTool('session_wrapup', {}, { ...context, requestWrapup })).rejects.toThrow(/session_ids or session_id/)
        const requestHandoff = vi.fn(async () => ({ sessionId: 'a1', state: 'running' as const }))
        expect(await executeWrapupTool('session_handoff', { from: 'a1', to: 'b1' }, { ...context, requestHandoff })).toEqual({ ok: true, sessionId: 'a1', state: 'running' })
    })
})
