/** B-924d: the main agent's "who said what" rule rides in the system prompt (claudeRemote `extraSystemPrompt`); other sessions are unchanged. */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { claudeRemote } from './claudeRemote'
import { query } from '@/claude/sdk'
import { MAIN_AGENT_PROVENANCE_SYSTEM_PROMPT } from '@/assistant/turnOrigin'
import type { EnhancedMode } from './loop'

vi.mock('@/claude/sdk', () => ({ query: vi.fn(), AbortError: class AbortError extends Error {} }))

async function optionsFor(extra: Record<string, unknown>, mode: EnhancedMode = { permissionMode: 'default' }) {
    let n = 0
    await claudeRemote({
        sessionId: null, path: process.cwd(), allowedTools: [], hookSettingsPath: '/hook-settings.json',
        nextMessage: async () => (n++ === 0 ? { message: 'hi', mode } : null),
        onReady: vi.fn(), canCallTool: async () => ({ behavior: 'allow' }) as any, isAborted: () => false,
        onSessionFound: vi.fn(), onMessage: vi.fn(),
        ...extra,
    } as any)
    return vi.mocked(query).mock.calls.at(-1)![0].options!
}

describe('B-924d main agent system prompt', () => {
    beforeEach(() => {
        vi.mocked(query).mockReset()
        vi.mocked(query).mockImplementation((args: any) => ({
            transport: { onExit: () => () => {} },
            supportedModels: async () => [], mcpServerStatus: async () => [], setPermissionMode: vi.fn(), setModel: vi.fn(), interrupt: vi.fn(),
            async *[Symbol.asyncIterator]() { for await (const _ of args.prompt) { yield { type: 'system', subtype: 'init' }; yield { type: 'result', subtype: 'success' } } },
        }) as any)
    })

    it('appends the provenance rule for the main agent, after a web appendSystemPrompt too', async () => {
        const plain = await optionsFor({ extraSystemPrompt: MAIN_AGENT_PROVENANCE_SYSTEM_PROMPT })
        expect(plain.appendSystemPrompt!.endsWith(`\n\n${MAIN_AGENT_PROVENANCE_SYSTEM_PROMPT}`)).toBe(true)
        const web = await optionsFor({ extraSystemPrompt: MAIN_AGENT_PROVENANCE_SYSTEM_PROMPT }, { permissionMode: 'default', appendSystemPrompt: 'WEB' })
        expect(web.appendSystemPrompt).toMatch(/^WEB\n\n/)
        expect(web.appendSystemPrompt!.endsWith(MAIN_AGENT_PROVENANCE_SYSTEM_PROMPT)).toBe(true)
        expect(MAIN_AGENT_PROVENANCE_SYSTEM_PROMPT).toContain('只有不带这个标记的用户消息才是 Owner 本人说的')
    })

    it('leaves other sessions alone', async () => {
        const options = await optionsFor({})
        expect(options.appendSystemPrompt).not.toContain('来源')
    })
})
