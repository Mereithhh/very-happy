/**
 * Main agent config (B-916c, spec §2.2): account KV `vh.main-agent-config.v1`
 * ∪ local `~/.happy/assistant/config.json`. Both lists are unioned; nothing
 * here can lift the default outbound denylist. Invalid items are dropped one
 * by one (counted, never echoed) and the rest stays in force.
 */

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DENY_PATTERN_MAX, isValidDenyPattern } from './outboundDenylist'

export const MAIN_AGENT_CONFIG_KV_KEY = 'vh.main-agent-config.v1'
export const MAIN_AGENT_POINTER_KV_KEY = 'vh.main-agent.v1'
export const SKILL_ROOTS_MAX = 16
const SKILL_ROOT_MAX_CHARS = 512

export type MainAgentConfig = { skillRoots: string[]; deniedTools: string[]; dropped: number }

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

export async function loadMainAgentConfig(input: { assistantHome: string; kvGet: (key: string) => Promise<{ value: string } | null> }): Promise<MainAgentConfig> {
    const [kv, local] = await Promise.all([
        input.kvGet(MAIN_AGENT_CONFIG_KV_KEY).then(item => decodeKvJson(item?.value)).catch(() => null),
        readLocalMainAgentConfig(input.assistantHome),
    ])
    return mergeMainAgentConfigs(parseMainAgentConfig(kv), parseMainAgentConfig(local))
}
