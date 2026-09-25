import { describe, expect, it } from 'vitest'
import { EditReportThrottle, extractAcpEditPaths, extractClaudeEditPaths, extractCodexPatchPaths } from './editPaths'

describe('extractClaudeEditPaths (B-497)', () => {
    const line = (content: unknown[]) => ({ type: 'assistant', message: { role: 'assistant', content } })

    it('keeps the transcript line timestamp so replayed history is not "now"', () => {
        const stamped = { ...line([{ type: 'tool_use', id: '1', name: 'Edit', input: { file_path: '/r/a.ts' } }]), timestamp: '2026-09-25T10:00:00.000Z' }
        expect(extractClaudeEditPaths(stamped)).toEqual([{ path: '/r/a.ts', tool: 'Edit', at: Date.parse('2026-09-25T10:00:00.000Z') }])
        expect(extractClaudeEditPaths({ ...stamped, timestamp: 'garbage' })[0].at).toBeUndefined()
    })

    it('takes file_path / notebook_path from the four write tools only', () => {
        expect(extractClaudeEditPaths(line([
            { type: 'text', text: 'hi' },
            { type: 'tool_use', id: '1', name: 'Read', input: { file_path: '/r/a.ts' } },
            { type: 'tool_use', id: '2', name: 'Edit', input: { file_path: '/r/b.ts', old_string: 'x', new_string: 'y' } },
            { type: 'tool_use', id: '3', name: 'Write', input: { file_path: 'rel/c.ts', content: '' } },
            { type: 'tool_use', id: '4', name: 'MultiEdit', input: { file_path: '/r/d.ts', edits: [] } },
            { type: 'tool_use', id: '5', name: 'NotebookEdit', input: { notebook_path: '/r/e.ipynb' } },
            { type: 'tool_use', id: '6', name: 'Bash', input: { command: 'echo > /r/f.ts' } },
            { type: 'tool_use', id: '7', name: 'Edit', input: { file_path: '' } },
        ]))).toEqual([
            { path: '/r/b.ts', tool: 'Edit' }, { path: 'rel/c.ts', tool: 'Write' },
            { path: '/r/d.ts', tool: 'MultiEdit' }, { path: '/r/e.ipynb', tool: 'NotebookEdit' },
        ])
    })

    it('ignores user lines, tool results and malformed input', () => {
        expect(extractClaudeEditPaths({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: '2' }] } })).toEqual([])
        expect(extractClaudeEditPaths(line([{ type: 'tool_use', name: 'Edit', input: 'nope' }]))).toEqual([])
        expect(extractClaudeEditPaths(null)).toEqual([])
        expect(extractClaudeEditPaths({ type: 'assistant', message: { content: 'text only' } })).toEqual([])
    })
})

describe('extractCodexPatchPaths', () => {
    it('uses the change map keys', () => {
        expect(extractCodexPatchPaths({ '/r/a.ts': { kind: { type: 'update' } }, 'b.ts': {} })).toEqual([
            { path: '/r/a.ts', tool: 'CodexPatch' }, { path: 'b.ts', tool: 'CodexPatch' },
        ])
        expect(extractCodexPatchPaths(undefined)).toEqual([])
        expect(extractCodexPatchPaths([])).toEqual([])
    })
})

describe('extractAcpEditPaths', () => {
    it('reads pi write / edit rawInput.path and nothing for other pi tools', () => {
        expect(extractAcpEditPaths('edit', { piTool: 'edit', rawInput: { path: 'src/a.ts', edits: [] } })).toEqual([{ path: 'src/a.ts', tool: 'edit' }])
        expect(extractAcpEditPaths('other', { piTool: 'write', rawInput: { path: '/r/b.ts', content: '' } })).toEqual([{ path: '/r/b.ts', tool: 'write' }])
        expect(extractAcpEditPaths('read', { piTool: 'read', rawInput: { path: '/r/b.ts' } })).toEqual([])
        expect(extractAcpEditPaths('edit', { piTool: 'edit', rawInput: {} })).toEqual([])
    })

    it('falls back to ACP locations for a non-pi edit kind', () => {
        expect(extractAcpEditPaths('edit', { locations: [{ path: '/r/a.ts', line: 1 }, { path: '/r/a.ts' }, { path: '/r/c.ts' }] }))
            .toEqual([{ path: '/r/a.ts', tool: 'edit' }, { path: '/r/c.ts', tool: 'edit' }])
        expect(extractAcpEditPaths('read', { locations: [{ path: '/r/a.ts' }] })).toEqual([])
        expect(extractAcpEditPaths('edit', null)).toEqual([])
    })
})

describe('EditReportThrottle', () => {
    it('reports each path once per interval', () => {
        const throttle = new EditReportThrottle(5_000)
        const edit = { path: '/r/a.ts', tool: 'Edit' }
        expect(throttle.take([edit], 1_000)).toEqual([edit])
        expect(throttle.take([edit], 3_000)).toEqual([])
        expect(throttle.take([edit, { path: '/r/b.ts', tool: 'Write' }], 6_500)).toEqual([edit, { path: '/r/b.ts', tool: 'Write' }])
    })
})
