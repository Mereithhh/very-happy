/**
 * Main agent — what its file tools may touch under HAPPY_HOME (B-922, QA P2-2).
 *
 * HAPPY_HOME (`~/.happy`, and `$HAPPY_HOME_DIR`) holds credentials and every
 * local record the gates trust: approval records, the wrap-up card hashes,
 * the follow-up ledger, settings approvals, daemon state. Rather than list
 * them (and miss the next one), HAPPY_HOME is closed to the main agent's file
 * tools, with a small read-only allowlist:
 *
 *  - read (Read / Grep / Glob): only `assistant/CLAUDE.md`, `assistant/memory/**`
 *    (personal memory + journal) and `uploads/chat/**` (attachments the owner
 *    sends in chat); a Grep / Glob whose root is not inside those, or that
 *    covers HAPPY_HOME (`~`, `/`, the assistant home itself), is refused;
 *  - write (Edit / Write / MultiEdit / NotebookEdit): nothing under HAPPY_HOME.
 *    `memory_update` / `journal_append` are MCP tools that write in the wrapper.
 *
 * Paths are resolved (`~`, relative to the call's cwd, `..`, symlinks through
 * the nearest existing ancestor, dangling symlinks too) before the check; hard
 * links cannot be told apart from the file (needs a shell to create: same limit
 * as Bash on). In every preset. The wrapper
 * and the daemon read and write these files directly, not through these tools.
 * With Bash on the agent can read them anyway: stated in the Web toggle and
 * spec §4.3; server-side hardening is B-927.
 */

import { existsSync, lstatSync, readlinkSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/** The gates' own approval records (moved out of the assistant home). */
export const MAIN_AGENT_APPROVALS_DIR = 'main-agent-approvals'

const READ_TOOLS: Readonly<Record<string, string>> = { Read: 'file_path' }
const WRITE_TOOLS: Readonly<Record<string, string>> = { Edit: 'file_path', Write: 'file_path', MultiEdit: 'file_path', NotebookEdit: 'notebook_path' }
const SEARCH_TOOLS = new Set(['Grep', 'Glob'])

export const PROTECTED_PATH_REASON = '主 agent 不能读写 Very Happy 数据目录（~/.happy）里的文件，只能读自己的 CLAUDE.md、memory/ 和聊天附件。'
    + ' (The main agent may not read or write files in the Very Happy data directory, except reading its own CLAUDE.md, memory/ and chat attachments.)'
export const BROAD_SEARCH_REASON = '这个搜索范围包含 Very Happy 的数据目录（含凭据和审批记录）。检索记忆请把 path 设成 memory/，其他内容换一个不含 ~/.happy 的目录。'
    + ' (This search covers the Very Happy data directory; search memory/ for memory, or a directory outside ~/.happy.)'

function expand(path: string, cwd: string, home: string): string {
    const p = path === '~' ? home : path.startsWith('~/') ? join(home, path.slice(2)) : path
    return isAbsolute(p) ? resolve(p) : resolve(cwd, p)
}

/** A symlink whose target does not exist (yet): existsSync says false, lstat says link. */
function danglingLinkTarget(path: string): string | null {
    try {
        if (!lstatSync(path).isSymbolicLink()) return null
        const target = readlinkSync(path)
        return isAbsolute(target) ? resolve(target) : resolve(dirname(path), target)
    } catch { return null }
}

/**
 * Resolve symlinks through the nearest existing ancestor (the leaf may not exist yet).
 * A dangling symlink on the way is followed too (QA-U r2 P3-3: `/tmp/x.json` →
 * `~/.happy/.../forged.json` before the target exists), up to `hops` links.
 * Hard links have no target to follow: a known limit (spec §4.3).
 */
function real(path: string, hops = 8): string {
    let cur = path
    const rest: string[] = []
    while (!existsSync(cur)) {
        const target = hops > 0 ? danglingLinkTarget(cur) : null
        if (target !== null) return real(join(target, ...rest), hops - 1)
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

/**
 * `happyHomes`: the configured HAPPY_HOME plus `$HAPPY_HOME_DIR` (both are
 * resolved; duplicates collapse). The allowlist is relative to each.
 */
export function protectedPathsFor(happyHomes: string | readonly string[], opts: { home?: string } = {}): ProtectedPaths {
    const home = opts.home ?? homedir()
    const roots = [...new Set((Array.isArray(happyHomes) ? happyHomes : [happyHomes]).filter((h): h is string => typeof h === 'string' && h.length > 0).flatMap((h) => {
        const abs = resolve(expand(h, home, home))
        return [abs, real(abs)]
    }))]
    const readFiles = roots.map((r) => join(r, 'assistant', 'CLAUDE.md'))
    const readDirs = roots.flatMap((r) => [join(r, 'assistant', 'memory'), join(r, 'uploads', 'chat')])
    const underHome = (p: string) => roots.some((r) => inside(p, r))
    const readable = (p: string) => readFiles.includes(p) || readDirs.some((d) => inside(p, d))
    /** The real path and the lexical one: both must pass (a symlink inside the allowlist pointing out, or the reverse). */
    const both = (raw: string, base: string) => { const lex = expand(raw, base, home); return [lex, real(lex)] }

    return {
        check(toolName, toolInput, cwd) {
            const input = toolInput && typeof toolInput === 'object' ? toolInput as Record<string, unknown> : {}
            const base = cwd && isAbsolute(cwd) ? cwd : process.cwd()
            const writeField = WRITE_TOOLS[toolName]
            if (writeField) {
                const v = input[writeField]
                if (typeof v === 'string' && v && both(v, base).some(underHome)) return PROTECTED_PATH_REASON
                return null
            }
            const readField = READ_TOOLS[toolName]
            if (readField) {
                const v = input[readField]
                if (typeof v === 'string' && v && both(v, base).some((p) => underHome(p) && !readable(p))) return PROTECTED_PATH_REASON
                return null
            }
            if (SEARCH_TOOLS.has(toolName)) {
                const raw = typeof input.path === 'string' && input.path ? input.path : base
                let target = raw
                // Glob: the pattern's fixed prefix narrows (or widens: `../`, absolute, `~`) the real search root
                const pattern = typeof input.pattern === 'string' ? input.pattern : ''
                if (toolName === 'Glob' && pattern) {
                    const parts = pattern.split(/[\\/]/)
                    const cut = parts.findIndex((part) => /[*?[{]/.test(part))
                    const fixed = (cut === -1 ? parts.slice(0, -1) : parts.slice(0, cut)).join(sep)
                    if (fixed || isAbsolute(pattern)) target = isAbsolute(pattern) || pattern.startsWith('~') ? (fixed || sep) : join(expand(raw, base, home), fixed)
                }
                for (const r of both(target, base)) {
                    if (roots.some((h) => inside(h, r))) return BROAD_SEARCH_REASON
                    if (underHome(r) && !readable(r)) return BROAD_SEARCH_REASON
                }
            }
            return null
        },
    }
}

/** HAPPY_HOME candidates for the guard: the configured one and `$HAPPY_HOME_DIR`. */
export function happyHomeCandidates(configured: string, env: NodeJS.ProcessEnv = process.env): string[] {
    return [configured, ...(env.HAPPY_HOME_DIR ? [env.HAPPY_HOME_DIR] : [])]
}
