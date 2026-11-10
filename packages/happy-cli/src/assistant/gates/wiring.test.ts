import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { claudeRemote } from '@/claude/claudeRemote'
import { query } from '@/claude/sdk'
import type { EnhancedMode } from '@/claude/loop'

vi.mock('@/claude/sdk', () => ({
    query: vi.fn(),
    AbortError: class AbortError extends Error {},
}))

const mode: EnhancedMode = { permissionMode: 'bypassPermissions' }
const src = (path: string) => readFileSync(join(__dirname, '..', '..', path), 'utf8')

describe('B-916c main agent gate wiring', () => {
    beforeEach(() => { vi.mocked(query).mockReset() })

    it('claudeRemote hands the gate hook to the SDK as a blocking PreToolUse hook', async () => {
        const hook = vi.fn(async () => ({ continue: true }))
        let seen: any
        vi.mocked(query).mockImplementation((args: any) => { seen = args.options; return { async *[Symbol.asyncIterator]() {} } as any })
        let n = 0
        await claudeRemote({ sessionId: null, path: process.cwd(), allowedTools: [], hookSettingsPath: '/unused.json', preToolUseHook: hook,
            nextMessage: async () => ++n === 1 ? { message: 'hi', mode } : null, onReady: vi.fn(),
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }), isAborted: () => false, onSessionFound: vi.fn(), onMessage: vi.fn() })
        expect(seen.hooks).toEqual({ PreToolUse: [{ hooks: [hook], onFailure: 'block' }] })
    })

    it('claudeRemote sets no hooks for ordinary sessions', async () => {
        let seen: any
        vi.mocked(query).mockImplementation((args: any) => { seen = args.options; return { async *[Symbol.asyncIterator]() {} } as any })
        let n = 0
        await claudeRemote({ sessionId: null, path: process.cwd(), allowedTools: [], hookSettingsPath: '/unused.json',
            nextMessage: async () => ++n === 1 ? { message: 'hi', mode } : null, onReady: vi.fn(),
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }), isAborted: () => false, onSessionFound: vi.fn(), onMessage: vi.fn() })
        expect(seen.hooks).toBeUndefined()
    })

    it('the SDK adapter forwards hooks', () => {
        expect(src('claude/sdk/query.ts')).toContain('hooks: opts?.hooks,')
    })

    it('the remote launcher passes the session guard (hook + skillRoots)', () => {
        const launcher = src('claude/claudeRemoteLauncher.ts')
        expect(launcher).toContain('additionalDirectories: [attachmentDirectory, ...(session.mainAgentGuard?.extraDirectories ?? [])],')
        expect(launcher).toContain('preToolUseHook: session.mainAgentGuard?.preToolUse,')
    })

    it('runClaude builds the runtime only for the main agent and installs the guard', () => {
        const run = src('claude/runClaude.ts')
        expect(run).toContain("const mainAgent = isAssistantVariant && !process.env.VH_TEAM_SCOPE_FILE ? await prepareMainAgentForSession(api, session) : undefined;")
        expect(run).toContain('startHappyServer(session, { assistant: isAssistantVariant, mainAgent,')
        expect(run).toContain('if (mainAgent) sessionInstance.mainAgentGuard = { preToolUse: mainAgent.preToolUse, extraDirectories: mainAgent.extraDirectories };')
        expect(run).toContain('setAssistantExtraDenied(runtime.denylist.sdkDisallowed);')
    })

    it('startHappyServer routes every dispatch-tool family through the gate', () => {
        const server = src('claude/utils/startHappyServer.ts')
        expect(server).toContain('options?.mainAgent && options.assistant && !process.env.VH_TEAM_SCOPE_FILE ? options.mainAgent.gate.wrap(mcp) : mcp;')
        expect(server).toContain('registerTeamsTools(dispatchRegistrar, sessionId);')
        expect(server).toContain('registerAutomationTools(dispatchRegistrar);')
        expect(server).toContain('registerSessionPeerTools(dispatchRegistrar, createSessionPeerToolExecutor(client));')
        expect(server).toContain('registerAssistantTools(dispatchRegistrar);')
        expect(server).toContain('if (options.mainAgent) options.mainAgent.gate.registerApprovedTool(mcp);')
    })
})
