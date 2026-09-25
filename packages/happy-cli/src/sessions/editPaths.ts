/**
 * Which files a runner is editing (B-497) — pure extractors over the raw
 * events each runner already emits, plus the throttle every wrapper applies
 * before reporting to the daemon (`/session-edit`).
 *
 * The signal recorded is the CALL, not its success: an `Edit` that fails
 * because the file changed underneath it is exactly the conflict the notice
 * exists for. Read-only tools never count.
 */

/** Claude Code tools whose `file_path` / `notebook_path` is a write. */
export const CLAUDE_EDIT_TOOLS: ReadonlySet<string> = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

export interface ObservedEdit {
    path: string
    tool: string
}

function pathOf(input: unknown): string | null {
    if (!input || typeof input !== 'object') return null
    const record = input as Record<string, unknown>
    const candidate = record.file_path ?? record.notebook_path
    return typeof candidate === 'string' && candidate.trim() !== '' ? candidate : null
}

/**
 * Edit calls in one raw Claude transcript line (the `'claude-session-message'`
 * tap: remote SDK, local scanner and terminal mirror all pass here).
 */
export function extractClaudeEditPaths(body: unknown): ObservedEdit[] {
    if (!body || typeof body !== 'object') return []
    const line = body as { type?: unknown; message?: { content?: unknown } }
    if (line.type !== 'assistant') return []
    const content = line.message?.content
    if (!Array.isArray(content)) return []
    const edits: ObservedEdit[] = []
    for (const block of content) {
        if (!block || typeof block !== 'object') continue
        const b = block as { type?: unknown; name?: unknown; input?: unknown }
        if (b.type !== 'tool_use' || typeof b.name !== 'string' || !CLAUDE_EDIT_TOOLS.has(b.name)) continue
        const path = pathOf(b.input)
        if (path) edits.push({ path, tool: b.name })
    }
    return edits
}

/** Codex `patch_apply_begin.changes` is keyed by path. */
export function extractCodexPatchPaths(changes: unknown): ObservedEdit[] {
    if (!changes || typeof changes !== 'object' || Array.isArray(changes)) return []
    return Object.keys(changes as Record<string, unknown>)
        .filter((path) => path.trim() !== '')
        .map((path) => ({ path, tool: 'CodexPatch' }))
}

/**
 * pi over ACP: `args.piTool` ∈ {write, edit} with `rawInput.path`
 * (pi-acp 0.0.33 shape, see web piToolMapping.ts); other ACP agents report
 * `kind === 'edit'` with `locations[].path`.
 */
export function extractAcpEditPaths(toolKind: string | undefined, args: unknown): ObservedEdit[] {
    if (!args || typeof args !== 'object') return []
    const a = args as { piTool?: unknown; rawInput?: unknown; locations?: unknown }
    if (a.piTool === 'write' || a.piTool === 'edit') {
        const raw = a.rawInput as Record<string, unknown> | undefined
        const path = raw && typeof raw.path === 'string' && raw.path.trim() !== '' ? raw.path : null
        return path ? [{ path, tool: a.piTool }] : []
    }
    if (typeof a.piTool === 'string') return []
    if (toolKind !== 'edit' || !Array.isArray(a.locations)) return []
    const edits: ObservedEdit[] = []
    for (const location of a.locations) {
        const path = location && typeof location === 'object' ? (location as { path?: unknown }).path : undefined
        if (typeof path === 'string' && path.trim() !== '' && !edits.some((e) => e.path === path)) edits.push({ path, tool: 'edit' })
    }
    return edits
}

/** Same wrapper, same path: one report per `intervalMs`. */
export class EditReportThrottle {
    private readonly lastReportedAt = new Map<string, number>()
    constructor(private readonly intervalMs = 5_000) {}

    /** Returns the edits that should be reported now and remembers them. */
    take(edits: readonly ObservedEdit[], now = Date.now()): ObservedEdit[] {
        const due: ObservedEdit[] = []
        for (const edit of edits) {
            const last = this.lastReportedAt.get(edit.path)
            if (last !== undefined && now - last < this.intervalMs) continue
            this.lastReportedAt.set(edit.path, now)
            due.push(edit)
        }
        // Bound the map: forget entries older than ten intervals.
        if (this.lastReportedAt.size > 512) {
            for (const [path, at] of this.lastReportedAt) if (now - at > this.intervalMs * 10) this.lastReportedAt.delete(path)
        }
        return due
    }
}
