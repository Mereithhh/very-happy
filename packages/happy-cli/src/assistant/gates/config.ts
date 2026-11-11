/**
 * Main agent config (B-916c, spec §2.2): account KV `vh.main-agent-config.v1`
 * ∪ local `~/.happy/assistant/config.json`. Both lists are unioned; nothing
 * here can lift the default outbound denylist. Invalid items are dropped one
 * by one (counted, never echoed) and the rest stays in force.
 *
 * B-922 `safety` (spec §4.4): the account setting decides; a local file can
 * only make each item stricter, and its `allowedTools` are ignored — the main
 * agent itself may be able to write that file, it can never loosen anything.
 */

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DENY_PATTERN_MAX, isValidDenyPattern } from './outboundDenylist'
import { ALLOWED_TOOLS_MAX, effectiveSafetyPolicy, isValidAllowedTool, parseMainAgentSafety, stricterPolicy, type MainAgentSafety, type MainAgentSafetyPolicy } from '@slopus/happy-wire'
import type { KvIo } from '../mainAgentPointer'

export const MAIN_AGENT_CONFIG_KV_KEY = 'vh.main-agent-config.v1'
export const MAIN_AGENT_POINTER_KV_KEY = 'vh.main-agent.v1'
export const SKILL_ROOTS_MAX = 16
const SKILL_ROOT_MAX_CHARS = 512

export type MainAgentSafetyRuntime = {
    /** The account setting as read (fail-closed parse). */
    safety: MainAgentSafety
    /** Effective per-item policy after the local file tightened it. */
    policy: MainAgentSafetyPolicy
    /** Exact tool names whose `ask` is `allow` (account setting only). */
    allowedTools: string[]
    /** The KV section was present but not understood (read as strict). */
    failedClosed: boolean
}
export type MainAgentConfig = { skillRoots: string[]; deniedTools: string[]; dropped: number; safety?: MainAgentSafetyRuntime }

export function isValidSkillRoot(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= SKILL_ROOT_MAX_CHARS
        && (value.startsWith('/') || value === '~' || value.startsWith('~/')) && !value.includes('\0') && !/[\r\n]/.test(value)
}

export function expandHome(path: string, home = homedir()): string {
    return path === '~' ? home : path.startsWith('~/') ? join(home, path.slice(2)) : path
}

/** One source (KV value or local file) → its valid items. Anything malformed counts as dropped. */
export function parseMainAgentConfig(raw: unknown): MainAgentConfig {
    const out: MainAgentConfig = { skillRoots: [], deniedTools: [], dropped: 0 }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
    const obj = raw as Record<string, unknown>
    if (Array.isArray(obj.skillRoots)) for (const item of obj.skillRoots) {
        if (isValidSkillRoot(item) && out.skillRoots.length < SKILL_ROOTS_MAX) out.skillRoots.push(item)
        else out.dropped++
    } else if (obj.skillRoots !== undefined) out.dropped++
    if (Array.isArray(obj.deniedTools)) for (const item of obj.deniedTools) {
        if (isValidDenyPattern(item) && out.deniedTools.length < DENY_PATTERN_MAX) out.deniedTools.push(item)
        else out.dropped++
    } else if (obj.deniedTools !== undefined) out.dropped++
    return out
}

export function mergeMainAgentConfigs(...configs: MainAgentConfig[]): MainAgentConfig {
    const roots = new Set<string>()
    const denied = new Map<string, string>()
    let dropped = 0
    for (const c of configs) {
        dropped += c.dropped
        for (const r of c.skillRoots) roots.add(r)
        for (const d of c.deniedTools) if (!denied.has(d.toLowerCase())) denied.set(d.toLowerCase(), d)
    }
    return { skillRoots: [...roots].slice(0, SKILL_ROOTS_MAX), deniedTools: [...denied.values()].slice(0, DENY_PATTERN_MAX), dropped }
}

/** KV values are base64 UTF-8 JSON (the `vh.board-tasks.v1` convention). */
export function decodeKvJson(value: string | null | undefined): unknown {
    if (typeof value !== 'string' || !value) return null
    try { return JSON.parse(Buffer.from(value, 'base64').toString('utf8')) } catch { return null }
}

export async function readLocalMainAgentConfig(assistantHome: string): Promise<unknown> {
    try { return JSON.parse(await readFile(join(assistantHome, 'config.json'), 'utf8')) } catch { return null }
}

/** Any value the parser does not understand reads as strict. */
const FAIL_CLOSED = Symbol('unreadable')

/** Account `safety` section, tightened per item by the local file's (whose allowedTools never count). */
export function resolveMainAgentSafety(kv: unknown, local: unknown): MainAgentSafetyRuntime {
    const section = (raw: unknown) => raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>).safety : undefined
    const account = parseMainAgentSafety(section(kv))
    let policy = effectiveSafetyPolicy(account.safety)
    const localSection = section(local)
    if (localSection !== undefined) policy = stricterPolicy(policy, effectiveSafetyPolicy(parseMainAgentSafety(localSection).safety))
    return { safety: account.safety, policy, allowedTools: [...account.safety.allowedTools], failedClosed: account.failedClosed }
}

export async function loadMainAgentConfig(input: { assistantHome: string; kvGet: (key: string) => Promise<{ value: string } | null> }): Promise<MainAgentConfig> {
    let kvFailed = false
    const [kv, local] = await Promise.all([
        input.kvGet(MAIN_AGENT_CONFIG_KV_KEY).then(item => {
            const value = decodeKvJson(item?.value)
            // a value that is there but not JSON is as unreadable as a failed request
            if (item && value === null) kvFailed = true
            return value
        }).catch(() => { kvFailed = true; return null }),
        readLocalMainAgentConfig(input.assistantHome),
    ])
    // B-922: an unreadable account setting must not fall back to the (looser) default preset.
    // QA P3: a value that is JSON but not an object (e.g. `[]`) is as unreadable as a failed request (the server's rule too).
    if (kv !== null && (typeof kv !== 'object' || Array.isArray(kv))) kvFailed = true
    const safety = resolveMainAgentSafety(kvFailed ? { safety: FAIL_CLOSED } : kv, local)
    return { ...mergeMainAgentConfigs(parseMainAgentConfig(kv), parseMainAgentConfig(local)), safety }
}

/**
 * B-922 "以后都允许这个工具": add `toolName` to the account `safety.allowedTools`.
 * Written with the machine token; the server lets a machine token add exactly
 * the tools the owner chose "always" for on a gate-1 card (spec §4.4), so this
 * write is only accepted for such a tool. A section this CLI does not
 * understand is left alone (never rewritten into something looser or lost).
 */
export async function persistAllowedTool(io: KvIo, toolName: string, now: () => number = Date.now): Promise<'written' | 'unchanged' | 'unsupported' | 'conflict' | 'refused' | 'unavailable'> {
    if (!isValidAllowedTool(toolName)) return 'unsupported'
    for (let attempt = 0; attempt < 2; attempt++) {
        let read: { value: string; version: number } | null
        try { read = await io.get(MAIN_AGENT_CONFIG_KV_KEY) } catch { return 'unavailable' }
        const raw = decodeKvJson(read?.value)
        const base: Record<string, unknown> = raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...(raw as Record<string, unknown>) } : { v: 1 }
        const parsed = parseMainAgentSafety(base.safety)
        if (parsed.failedClosed) return 'unsupported'
        if (parsed.safety.allowedTools.some(t => t.toLowerCase() === toolName.toLowerCase())) return 'unchanged'
        if (parsed.safety.allowedTools.length >= ALLOWED_TOOLS_MAX) return 'unsupported'
        const section: Record<string, unknown> = base.safety && typeof base.safety === 'object' ? { ...(base.safety as Record<string, unknown>) } : { v: 1, preset: parsed.safety.preset }
        section.allowedTools = [...parsed.safety.allowedTools, toolName]
        const next = { ...base, v: 1, safety: section, updatedAt: now() }
        let result: 'ok' | 'conflict'
        // 422 = the server holds no live "always" card for this tool (the owner took it back): 'refused', not a network failure
        try { result = await io.set(MAIN_AGENT_CONFIG_KV_KEY, Buffer.from(JSON.stringify(next), 'utf8').toString('base64'), read ? read.version : -1) } catch (e) { return e instanceof Error && e.message === 'kv 422' ? 'refused' : 'unavailable' }
        if (result === 'ok') return 'written'
    }
    return 'conflict'
}
