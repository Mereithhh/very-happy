/**
 * Main agent gate 1 — outbound tool denylist (B-916c, specs/2026-11-main-agent.md §4.1).
 *
 * The main agent may read anything but must never send outside Very Happy or
 * write production by itself. Built-in mutating tools are already denied by
 * B-063 (dispatcherTools.ts); this adds the MCP surface the user brings along
 * (their own IM / mail / code-host / deploy servers), matched by NAME PATTERN
 * so the product never hard-codes a particular service.
 *
 * Pattern format: `*` is the only wildcard (any run, including empty), every
 * other character is literal, matching is case-insensitive and anchored to the
 * whole tool name (`Bash`, `mcp__<server>__<tool>`). Allowed characters
 * `[A-Za-z0-9_.*-]`, length 1–128; anything else is dropped.
 *
 * Very Happy's own MCP server (`mcp__happy__*`) is exempt from the DEFAULT
 * verbs — session-to-session dispatch there is gate 2's job — but patterns the
 * user adds apply to every tool. The effective list can only grow.
 */

import { ASSISTANT_DISALLOWED_TOOLS } from '../dispatcherTools'

/** The MCP server key Very Happy registers its own tools under (runClaude.ts `mcpServers.happy`). */
export const VH_MCP_SERVER = 'happy'

/** Default verbs. Kept generic on purpose: no service names. */
export const DEFAULT_OUTBOUND_DENY_PATTERNS: readonly string[] = [
    'mcp__*__*send*',
    'mcp__*__*post*',
    'mcp__*__*reply*',
    'mcp__*__*publish*',
    'mcp__*__*deploy*',
    'mcp__*__*add_message*',
    'mcp__*__*create_message*',
    'mcp__*__*comment*',
    'mcp__*__*push*',
    'mcp__*__*merge*',
    'mcp__*__*release*',
    'mcp__*__*invite*',
    'mcp__*__*share*',
    'mcp__*__*email*',
    'mcp__*__*sms*',
    'mcp__*__*forward*',
    'mcp__*__*broadcast*',
    'mcp__*__*notify*',
    'mcp__*__*upload*',
    'mcp__*__*create_issue*',
    'mcp__*__*pull_request*',
    'mcp__*__*rollback*',
]

export const DENY_PATTERN_MAX = 64
const PATTERN_RE = /^[A-Za-z0-9_.*-]{1,128}$/

export const OUTBOUND_DENY_REASON = '主 agent 不能直接对外发送或做生产写入；请用派活工具并标 risk，或出 decision 卡。'
    + ' (The main agent cannot send outside Very Happy or write production itself; dispatch with a risk level instead.)'

export function isValidDenyPattern(pattern: unknown): pattern is string {
    return typeof pattern === 'string' && PATTERN_RE.test(pattern)
}

/** `*` → `.*`, everything else literal; anchored, case-insensitive. */
export function denyPatternToRegExp(pattern: string): RegExp {
    const body = pattern.split('*').map(part => part.replace(/[.\\+?^${}()|[\]-]/g, '\\$&')).join('.*')
    return new RegExp(`^${body}$`, 'i')
}

/** True for tools of Very Happy's own MCP server. */
export function isVhOwnTool(toolName: string): boolean {
    return toolName.toLowerCase().startsWith(`mcp__${VH_MCP_SERVER}__`)
}

/**
 * Names the SDK can drop natively (`disallowedTools`): plain names without a
 * wildcard, plus whole-server specs `mcp__<server>__*` / `mcp__<server>`.
 */
export function isSdkNativePattern(pattern: string): boolean {
    if (!pattern.includes('*')) return true
    return /^mcp__[A-Za-z0-9_.-]+__\*$/.test(pattern)
}

export type CompiledDenylist = {
    /** Every valid pattern in force (defaults first, then user additions; de-duplicated). */
    patterns: string[]
    /** User patterns dropped as invalid (count only reaches logs). */
    dropped: number
    /** The tool is denied for the main agent. */
    denies(toolName: string): boolean
    /** Extra entries to merge into SDK `disallowedTools`. */
    sdkDisallowed: string[]
}

/**
 * Build the effective denylist. `extra` = KV `deniedTools` ∪ local config
 * `deniedTools`; it can only add.
 */
export function compileOutboundDenylist(extra: readonly unknown[] = []): CompiledDenylist {
    const defaults = DEFAULT_OUTBOUND_DENY_PATTERNS.map(p => ({ pattern: p, re: denyPatternToRegExp(p) }))
    const seen = new Set(DEFAULT_OUTBOUND_DENY_PATTERNS.map(p => p.toLowerCase()))
    const user: Array<{ pattern: string; re: RegExp }> = []
    let dropped = 0
    for (const raw of extra) {
        if (!isValidDenyPattern(raw) || user.length >= DENY_PATTERN_MAX) { dropped++; continue }
        const key = raw.toLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        user.push({ pattern: raw, re: denyPatternToRegExp(raw) })
    }
    const builtins = new Set<string>(ASSISTANT_DISALLOWED_TOOLS.map(t => t.toLowerCase()))
    return {
        patterns: [...defaults, ...user].map(e => e.pattern),
        dropped,
        denies(toolName: string): boolean {
            if (typeof toolName !== 'string' || !toolName) return false
            if (builtins.has(toolName.toLowerCase())) return true
            if (user.some(e => e.re.test(toolName))) return true
            if (isVhOwnTool(toolName)) return false
            return defaults.some(e => e.re.test(toolName))
        },
        sdkDisallowed: user.filter(e => isSdkNativePattern(e.pattern)).map(e => e.pattern),
    }
}

/**
 * SDK `hooks.PreToolUse` callback for the main agent: deny every call the
 * list matches. Runs in every permission mode, bypassPermissions included.
 */
export function outboundPreToolUseHook(list: Pick<CompiledDenylist, 'denies'>, onDeny?: (toolName: string) => void) {
    return async (input: { hook_event_name?: string; tool_name?: string }) => {
        if (input?.hook_event_name !== 'PreToolUse' || typeof input.tool_name !== 'string') return { continue: true }
        if (!list.denies(input.tool_name)) return { continue: true }
        onDeny?.(input.tool_name)
        return {
            hookSpecificOutput: {
                hookEventName: 'PreToolUse' as const,
                permissionDecision: 'deny' as const,
                permissionDecisionReason: OUTBOUND_DENY_REASON,
            },
        }
    }
}
