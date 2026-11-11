import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
    BODY_MAX_CHARS, LIST_LINE_MAX_CHARS, LIST_MAX_CHARS, RECEIPT_MAX_CHARS,
    capClassFor, capReceiptText, capToolResult, jsonReceipt, pageText, parseCursor, withToolOutputCaps,
} from './toolCaps'
import { ASSISTANT_TOOL_NAMES, type AssistantToolRegistrar } from './assistantTools'

type Handler = (args: any, extra?: any) => Promise<any>
function recorder() {
    const tools = new Map<string, { config: any; handler: Handler }>()
    const server = { registerTool: ((name: string, config: any, handler: Handler) => { tools.set(name, { config, handler }); return {} as never }) } as unknown as AssistantToolRegistrar
    return { tools, server }
}
const textResult = (text: string, isError = false) => ({ content: [{ type: 'text', text }], isError })
const out = (r: any) => r.content.map((c: any) => c.text).join('\n') as string

/** Follow cursors until the answer ends; returns the pages. */
function allPages(text: string, cls: 'list' | 'body'): string[] {
    const pages: string[] = []
    let cursor: string | undefined
    for (let i = 0; i < 1000; i++) {
        const page = pageText(text, cls, cursor)
        pages.push(page)
        const next = page.match(/cursor="(\d+)" for the rest\]$/)
        if (!next) return pages
        cursor = next[1]
    }
    throw new Error('no end')
}
const strip = (page: string) => page.replace(/^\[continued from cursor="\d+"\]\n/, '').replace(/\n\[truncated: [^\]]*\]$/, '')

describe('capReceiptText', () => {
    it('keeps a short receipt and cuts a long one to exactly the limit with a marker', () => {
        expect(capReceiptText('ok')).toBe('ok')
        const cut = capReceiptText('x'.repeat(5000))
        expect(cut.length).toBe(RECEIPT_MAX_CHARS)
        expect(cut.endsWith('…[truncated]')).toBe(true)
        expect(capReceiptText('y'.repeat(RECEIPT_MAX_CHARS))).toBe('y'.repeat(RECEIPT_MAX_CHARS))
    })

    it('never splits a surrogate pair', () => {
        const cut = capReceiptText('😀'.repeat(400))
        expect(cut.length).toBeLessThanOrEqual(RECEIPT_MAX_CHARS)
        expect(cut).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/)
    })
})

describe('jsonReceipt', () => {
    it('keeps identity fields of the top level and of nested objects, drops the rest', () => {
        const automation = { id: 'a1', name: 'daily', status: 'active', version: 3, nextRunAt: 1, action: { kind: 'spawn', prompt: 'p'.repeat(20_000) }, description: 'd'.repeat(5000) }
        const text = jsonReceipt({ automation })
        expect(text.length).toBeLessThanOrEqual(RECEIPT_MAX_CHARS)
        expect(JSON.parse(text)).toEqual({ ok: true, automation: { id: 'a1', name: 'daily', status: 'active', version: 3, nextRunAt: 1 } })
    })

    it('passes a fitting receipt through as written: gate 2 keeps approvalId / boardItemId', () => {
        const gate = { ok: true, state: 'awaiting_decision', approvalId: '6f1c2b8e-1a2b-4c3d-9e8f-0a1b2c3d4e5f', boardItemId: 'item-42' }
        expect(JSON.parse(out(capToolResult(textResult(JSON.stringify(gate)), 'receipt')))).toEqual(gate)
        const longer = { ...gate, detail: 'd'.repeat(600) }
        expect(JSON.parse(jsonReceipt(longer))).toEqual(gate)
    })

    it('fits a team write receipt (task ids survive, the team summary goes)', () => {
        const receipt = {
            ok: true, taskId: 't1',
            task: { id: 't1', status: 'running', currentAttemptId: 'a1', goalVersion: 2, goal: 'g'.repeat(200), assigneeBotId: 'b', ownerBotId: 'o' },
            team: { id: 'team', name: 'n', version: 9, capacity: { metrics: { bytes: { used: 1, limit: 2 } } }, idleMembers: Array.from({ length: 30 }, (_, i) => ({ botId: `bot-${i}`, name: `Member ${i}` })) },
            hint: 'Receipt only. '.repeat(20),
        }
        const parsed = JSON.parse(jsonReceipt(receipt))
        expect(parsed.taskId).toBe('t1')
        expect(parsed.task).toMatchObject({ id: 't1', status: 'running', currentAttemptId: 'a1', goalVersion: 2 })
        expect(jsonReceipt(receipt).length).toBeLessThanOrEqual(RECEIPT_MAX_CHARS)
    })

    it('falls back to top-level scalars, then to a cut, and stays within the limit', () => {
        const wide: Record<string, unknown> = { id: 'x'.repeat(100), title: 't'.repeat(300) }
        for (let i = 0; i < 30; i++) wide[`child${i}`] = { id: `c${i}-${'z'.repeat(20)}`, status: 'open' }
        const text = jsonReceipt(wide)
        expect(text.length).toBeLessThanOrEqual(RECEIPT_MAX_CHARS)
        expect(text).toContain('"id":"xxxx')
    })
})

describe('pageText', () => {
    it('passes a fitting answer through unchanged', () => {
        expect(pageText('a\nb', 'list')).toBe('a\nb')
        expect(pageText('x'.repeat(BODY_MAX_CHARS), 'body')).toBe('x'.repeat(BODY_MAX_CHARS))
    })

    it('clips list lines to 160 characters', () => {
        const page = pageText(`${'a'.repeat(1000)}\nshort`, 'list')
        const [first, second] = page.split('\n')
        expect(first.length).toBe(LIST_LINE_MAX_CHARS)
        expect(second).toBe('short')
    })

    it('every page of a long list / body is within its ceiling and the cursors cover the whole answer', () => {
        const list = Array.from({ length: 500 }, (_, i) => `line ${i} ${'x'.repeat(i % 150)}`).join('\n')
        const listPages = allPages(list, 'list')
        expect(listPages.length).toBeGreaterThan(5)
        for (const page of listPages) expect(page.length).toBeLessThanOrEqual(LIST_MAX_CHARS)
        expect(listPages.map(strip).join('')).toBe(list)
        // A list page ends on a whole line.
        expect(strip(listPages[0]).endsWith('\n')).toBe(true)

        const body = 'b'.repeat(50_000)
        const bodyPages = allPages(body, 'body')
        for (const page of bodyPages) expect(page.length).toBeLessThanOrEqual(BODY_MAX_CHARS)
        expect(bodyPages.map(strip).join('')).toBe(body)
        expect(bodyPages[0]).toMatch(/\[truncated: characters 0–\d+ of 50000 shown; call again with cursor="\d+" for the rest\]$/)
    })

    it('ignores a malformed cursor and clamps one past the end', () => {
        expect(parseCursor('12')).toBe(12)
        expect(parseCursor('-1')).toBe(0)
        expect(parseCursor('1e3')).toBe(0)
        expect(parseCursor(5)).toBe(0)
        expect(pageText('abc', 'body', '99')).toBe('[continued from cursor="3"]\n')
    })
})

describe('capClassFor', () => {
    it('classes every B-051 assistant tool explicitly', () => {
        const classes = Object.fromEntries(ASSISTANT_TOOL_NAMES.map(name => [name, capClassFor(name, {}, false)]))
        expect(classes).toEqual({
            sessions_list: 'list', session_read: 'body', session_send: 'receipt', session_spawn: 'receipt', session_kill: 'receipt', session_archive: 'receipt',
            terminals_list: 'list', terminal_read: 'body', terminal_send: 'receipt', memory_update: 'receipt', journal_append: 'receipt',
        })
    })

    it('team_inspect is a list by default and a body for one task or the full view', () => {
        expect(capClassFor('team_inspect', {}, true)).toBe('list')
        expect(capClassFor('team_inspect', { taskId: 't' }, true)).toBe('body')
        expect(capClassFor('team_inspect', { full: true }, true)).toBe('body')
    })

    it('falls back by shape', () => {
        expect(capClassFor('whatever_list', {}, false)).toBe('list')
        expect(capClassFor('something_get', {}, true)).toBe('body')
        expect(capClassFor('something_do', {}, false)).toBe('receipt')
    })
})

describe('capToolResult', () => {
    it('caps every error to a receipt, whatever the class', () => {
        const r = capToolResult(textResult('e'.repeat(9000), true), 'body')
        expect(r.isError).toBe(true)
        expect(out(r).length).toBeLessThanOrEqual(RECEIPT_MAX_CHARS)
    })

    it('a JSON list answer without a view is paged as indented JSON, entries clipped, not the whole answer', () => {
        const json = { tasks: Array.from({ length: 200 }, (_, i) => ({ id: `task-${i}`, goal: 'g'.repeat(300) })) }
        const page = out(capToolResult(textResult(JSON.stringify(json)), 'list'))
        expect(page.length).toBeLessThanOrEqual(LIST_MAX_CHARS)
        expect(page.length).toBeGreaterThan(LIST_MAX_CHARS / 2)
        expect(page).toContain('"id": "task-0"')
        expect(page).toMatch(/cursor="\d+"/)
        for (const line of page.split('\n').slice(0, -1)) expect(line.length).toBeLessThanOrEqual(LIST_LINE_MAX_CHARS)
    })

    it('uses a list formatter for a JSON list and falls back to paging text', () => {
        const fmt = (v: any) => Array.isArray(v?.items) ? v.items.map((i: any) => i.id).join('\n') : null
        expect(out(capToolResult(textResult(JSON.stringify({ items: [{ id: 'a', big: 'x'.repeat(9000) }, { id: 'b' }] })), 'list', undefined, fmt))).toBe('a\nb')
        const unknown = capToolResult(textResult(JSON.stringify({ other: 'y'.repeat(9000) })), 'list', undefined, fmt)
        expect(out(unknown).length).toBeLessThanOrEqual(LIST_MAX_CHARS)
    })
})

describe('withToolOutputCaps', () => {
    it('adds an optional cursor to pageable tools only, strips it before the handler, and pages with it', async () => {
        const { tools, server } = recorder()
        const capped = withToolOutputCaps(server)
        const seen: any[] = []
        const long = Array.from({ length: 400 }, (_, i) => `row ${i} ${'r'.repeat(40)}`).join('\n')
        capped.registerTool('thing_list', { description: 'd', inputSchema: { limit: z.number().optional() } } as any, (async (args: any) => { seen.push(args); return textResult(long) }) as any)
        capped.registerTool('thing_do', { description: 'd', inputSchema: { x: z.string() } } as any, (async () => textResult('done '.repeat(200))) as any)

        expect(Object.keys(tools.get('thing_list')!.config.inputSchema)).toEqual(['limit', 'cursor'])
        expect(Object.keys(tools.get('thing_do')!.config.inputSchema)).toEqual(['x'])

        const first = out(await tools.get('thing_list')!.handler({ limit: 3 }))
        expect(first.length).toBeLessThanOrEqual(LIST_MAX_CHARS)
        const cursor = first.match(/cursor="(\d+)"/)![1]
        const second = out(await tools.get('thing_list')!.handler({ limit: 3, cursor }))
        expect(second.startsWith(`[continued from cursor="${cursor}"]`)).toBe(true)
        expect(seen).toEqual([{ limit: 3 }, { limit: 3 }])

        expect(out(await tools.get('thing_do')!.handler({ x: '1' })).length).toBeLessThanOrEqual(RECEIPT_MAX_CHARS)
    })

    it('turns a throwing handler into a capped error and is idempotent', async () => {
        const { tools, server } = recorder()
        const capped = withToolOutputCaps(server)
        expect(withToolOutputCaps(capped)).toBe(capped)
        capped.registerTool('boom', { description: 'd', inputSchema: {} } as any, (async () => { throw new Error('x'.repeat(5000)) }) as any)
        const r = await tools.get('boom')!.handler({})
        expect(r.isError).toBe(true)
        expect(out(r).length).toBeLessThanOrEqual(RECEIPT_MAX_CHARS)
    })
})
