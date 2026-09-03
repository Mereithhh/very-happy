/**
 * `very-happy mcp` tool surface (runner-agnostic meta-agent).
 *
 * The contract has two halves and both are pinned here:
 *  - without HAPPY_SESSION_VARIANT=assistant the server registers exactly the
 *    one tool it always has (a plain `claude` must see no change);
 *  - with it — and not under a happy-managed claude — it also registers the
 *    assistant's six session tools, and nothing else.
 */

import { describe, expect, it } from 'vitest'
import { CLIPBOARD_TOOL_NAME } from '@/clipboard/limits'
import { ASSISTANT_SESSION_TOOL_NAMES, ASSISTANT_TOOL_NAMES, type AssistantToolRegistrar } from '@/assistant/assistantTools'
import { mcpToolNamesForSurface, resolveMcpToolSurface } from './mcpToolSurface'
import { registerMcpTools } from './mcp'

function recorder(): { names: string[]; server: AssistantToolRegistrar } {
    const names: string[] = []
    const server = {
        registerTool: ((name: string) => {
            names.push(name)
            return {} as never
        }) as unknown as AssistantToolRegistrar['registerTool'],
    }
    return { names, server }
}

describe('resolveMcpToolSurface', () => {
    it('is the clipboard-only server without the assistant variant env', () => {
        expect(resolveMcpToolSurface({})).toBe('clipboard')
        expect(resolveMcpToolSurface({ HAPPY_SESSION_VARIANT: undefined })).toBe('clipboard')
        expect(resolveMcpToolSurface({ HAPPY_SESSION_VARIANT: 'Assistant' })).toBe('clipboard')
        expect(resolveMcpToolSurface({ HAPPY_SESSION_VARIANT: 'assistant ' })).toBe('clipboard')
    })

    it('exposes the assistant surface inside an assistant-variant session', () => {
        expect(resolveMcpToolSurface({ HAPPY_SESSION_VARIANT: 'assistant' })).toBe('assistant')
        expect(resolveMcpToolSurface({ HAPPY_SESSION_VARIANT: 'assistant', HAPPY_MANAGED: '0' })).toBe('assistant')
    })

    it('stays clipboard-only under a happy-managed claude (its in-process server already has the tools)', () => {
        expect(resolveMcpToolSurface({ HAPPY_SESSION_VARIANT: 'assistant', HAPPY_MANAGED: '1' })).toBe('clipboard')
    })
})

describe('mcpToolNamesForSurface', () => {
    it('clipboard surface is exactly the historical tool list', () => {
        expect(mcpToolNamesForSurface('clipboard')).toEqual(['copy_to_clipboard'])
    })

    it('assistant surface adds the six session tools and none of the Claude-home tools', () => {
        const names = mcpToolNamesForSurface('assistant')
        expect(names).toEqual([CLIPBOARD_TOOL_NAME, ...ASSISTANT_SESSION_TOOL_NAMES])
        expect(names).toEqual([
            'copy_to_clipboard',
            'sessions_list',
            'session_read',
            'session_send',
            'session_spawn',
            'session_kill',
            'session_archive',
        ])
        for (const claudeOnly of ['terminals_list', 'terminal_read', 'terminal_send', 'memory_update', 'journal_append']) {
            expect(ASSISTANT_TOOL_NAMES).toContain(claudeOnly)
            expect(names).not.toContain(claudeOnly)
        }
    })
})

describe('registerMcpTools', () => {
    it('registers exactly the names the surface declares (clipboard)', () => {
        const { names, server } = recorder()
        registerMcpTools(server, 'clipboard')
        expect(names).toEqual([...mcpToolNamesForSurface('clipboard')])
    })

    it('registers exactly the names the surface declares (assistant)', () => {
        const { names, server } = recorder()
        registerMcpTools(server, 'assistant')
        expect(names).toEqual([...mcpToolNamesForSurface('assistant')])
    })
})
