/**
 * Main agent — paths its file tools may never touch (B-922, QA P2-2).
 *
 * Credentials and the local approval records live under HAPPY_HOME. If the
 * main agent could Read them, a token and secret would land in the model
 * context, and with Edit / Write it could forge an approval record. The
 * PreToolUse hook refuses Read / Edit / Write / MultiEdit / NotebookEdit on
 * these paths, and Grep / Glob whose search root is inside one of them or
 * contains HAPPY_HOME (search a narrower directory instead), in every preset.
 *
 * With Bash on, the agent can read these files anyway: that boundary is stated
 * in the Web toggle and spec §4.3, and server-side hardening is B-927.
 */

import { existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/** Root of the gates' own approval records (outside the assistant home, which the agent greps). */
export const MAIN_AGENT_APPROVALS_DIR = 'main-agent-approvals'

export const PROTECTED_FILE_NAMES: readonly string[] = ['access.key', 'agent.key', 'daemon.state.json', 'daemon.state.json.lock']
export const PROTECTED_DIR_NAMES: readonly string[] = [MAIN_AGENT_APPROVALS_DIR, 'settings-approvals']
/** Approval dirs from before B-922 moved them out of the assistant home. */
const LEGACY_DIRS: readonly string[] = [join('assistant', 'pending-dispatch'), join('assistant', 'pending-tool')]

const FILE_TOOLS: Readonly<Record<string, readonly string[]>> = {
    Read: ['file_path'], Edit: ['file_path'], Write: ['file_path'], MultiEdit: ['file_path'], NotebookEdit: ['notebook_path'],
}
const SEARCH_TOOLS = new Set(['Grep', 'Glob'])

export const PROTECTED_PATH_REASON = '主 agent 不能读写 Very Happy 的凭据和本机审批记录（access.key、agent.key、daemon.state.json、审批目录）。'
    + ' (The main agent may not read or write Very Happy credentials or the local approval records.)'
export const BROAD_SEARCH_REASON = '这个搜索范围包含 Very Happy 的数据目录（含凭据和审批记录），请换一个更小的目录再搜。'
    + ' (This search covers the Very Happy data directory; search a narrower directory.)'

function expand(path: string, cwd: string, home: string): string {
    const p = path === '~' ? home : path.startsWith('~/') ? join(home, path.slice(2)) : path
    return isAbsolute(p) ? resolve(p) : resolve(cwd, p)
}

/** Resolve symlinks through the nearest existing ancestor (the leaf may not exist yet). */
function real(path: string): string {
    let cur = path
    const rest: string[] = []
    while (!existsSync(cur)) {
        const parent = dirname(cur)
        if (parent === cur) return path
        rest.unshift(basename(cur))
        cur = parent
    }
    try { return join(realpathSync(cur), ...rest) } catch { return path }
}

const inside = (child: string, parent: string) => {
    const r = relative(parent, child)
    return r === '' || (!r.startsWith('..') && !isAbsolute(r))
}

export type ProtectedPaths = {
    /** null = allowed; otherwise the deny reason. */
    check(toolName: string, toolInput: unknown, cwd?: string): string | null
}

export function protectedPathsFor(happyHome: string, opts: { home?: string } = {}): ProtectedPaths {
    const home = opts.home ?? homedir()
    const root = real(resolve(happyHome))
    const files = PROTECTED_FILE_NAMES.map((f) => join(root, f))
    const dirs = [...PROTECTED_DIR_NAMES, ...LEGACY_DIRS].map((d) => join(root, d))
    const isProtected = (p: string) => files.includes(p) || dirs.some((d) => inside(p, d)) || (inside(p, root) && p.endsWith('.inflight'))
    return {
        check(toolName, toolInput, cwd) {
            const input = toolInput && typeof toolInput === 'object' ? toolInput as Record<string, unknown> : {}
            const base = cwd && isAbsolute(cwd) ? cwd : process.cwd()
            const fields = FILE_TOOLS[toolName]
            if (fields) {
                for (const f of fields) {
                    const v = input[f]
                    if (typeof v === 'string' && v && isProtected(real(expand(v, base, home)))) return PROTECTED_PATH_REASON
                }
                return null
            }
            if (SEARCH_TOOLS.has(toolName)) {
                const raw = typeof input.path === 'string' && input.path ? input.path : base
                const searchRoot = real(expand(raw, base, home))
                if (isProtected(searchRoot)) return PROTECTED_PATH_REASON
                if (inside(root, searchRoot)) return BROAD_SEARCH_REASON
                // Glob with an absolute pattern and no path
                const pattern = typeof input.pattern === 'string' ? input.pattern : ''
                if (toolName === 'Glob' && (isAbsolute(pattern) || pattern.startsWith('~'))) {
                    const parts = pattern.split(sep)
                    const cut = parts.findIndex((part) => /[*?[{]/.test(part))
                    const fixed = (cut === -1 ? parts : parts.slice(0, cut)).join(sep) || sep
                    const patRoot = real(expand(fixed, base, home))
                    if (isProtected(patRoot)) return PROTECTED_PATH_REASON
                    if (inside(root, patRoot)) return BROAD_SEARCH_REASON
                }
            }
            return null
        },
    }
}
