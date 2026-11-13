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
 *
 * B-922 (spec §4.4): the safety setting decides what happens to each class of
 * third-party MCP tool — production / outbound / other write — `deny` (B-916c,
 * the strict preset), `ask` (an approval card, toolApproval.ts) or `allow`.
 * The built-in tools and the user's own deny patterns stay hard denies; a
 * read-only tool is allowed unless its class is `deny`.
 */

import { PRESET_POLICIES, type MainAgentSafetyPolicy, type ToolPolicy } from '@slopus/happy-wire'
import { ASSISTANT_DISALLOWED_TOOLS, assistantBuiltinsAllowedBy } from '../dispatcherTools'
import type { ProtectedPaths } from './protectedPaths'

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

/**
 * QA77 #5: third-party MCP tools are denied by default — the main agent only
 * reads and dispatches. A tool passes only when its name (the part after
 * `mcp__<server>__`) starts with a read-only verb AND carries no write verb
 * anywhere (`get_or_create_*` is still denied) AND no deny pattern matches.
 */
export const READ_ONLY_TOOL_PREFIXES: readonly string[] = ['list', 'get', 'search', 'read', 'query', 'describe', 'fetch', 'find', 'show', 'view', 'lookup', 'count']
export const WRITE_VERB_TOKENS: readonly string[] = [
    'create', 'update', 'upsert', 'delete', 'remove', 'write', 'set', 'put', 'patch', 'post', 'send', 'reply', 'publish',
    'deploy', 'apply', 'exec', 'execute', 'run', 'push', 'merge', 'upload', 'invite', 'share', 'add', 'edit', 'move',
    'rename', 'approve', 'close', 'archive', 'click', 'type', 'fill', 'submit', 'tweet', 'comment', 'notify', 'forward',
    'install', 'kill', 'stop', 'start', 'restart', 'rollback', 'release', 'scale', 'drop', 'truncate', 'insert', 'grant',
]

/**
 * B-922: production-class tools — substring verbs (as in the default table) plus
 * whole-word infrastructure verbs. Asked for even in the loose preset.
 */
export const PRODUCTION_SUBSTRINGS: readonly string[] = ['deploy', 'release', 'rollback', 'publish']
export const PRODUCTION_VERB_TOKENS: readonly string[] = ['apply', 'scale', 'drop', 'truncate', 'migrate', 'rollout', 'terminate', 'destroy']

export function toolTokens(tool: string): Set<string> {
    const tokens = tool.toLowerCase().split(/[^a-z0-9]+|(?<=[a-z])(?=[0-9])/).filter(Boolean)
    const camel = tool.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
    return new Set([...tokens, ...camel])
}

export type ToolClass = 'production' | 'outbound' | 'thirdPartyWrite'

/** `mcp__<server>__<tool>` → `<tool>` (null for non-MCP names). */
export function mcpToolPart(toolName: string): string | null {
    const m = /^mcp__.+?__(.+)$/i.exec(toolName)
    return m ? m[1] : null
}

export function isReadOnlyMcpTool(toolName: string): boolean {
    const tool = mcpToolPart(toolName)
    if (!tool) return false
    const tokens = tool.toLowerCase().split(/[^a-z0-9]+|(?<=[a-z])(?=[0-9])/).filter(Boolean)
    // also split camelCase (getUser → get, user)
    const camel = tool.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
    const all = new Set([...tokens, ...camel])
    if (!READ_ONLY_TOOL_PREFIXES.includes(camel[0] ?? '')) return false
    return !WRITE_VERB_TOKENS.some(verb => all.has(verb))
}

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

/** What gate 1 does with one call. */
export type ToolDecision = 'allow' | 'ask' | 'deny'

export type CompiledDenylist = {
    /** Every valid pattern in force (defaults first, then user additions; de-duplicated). */
    patterns: string[]
    /** User patterns dropped as invalid (count only reaches logs). */
    dropped: number
    /** The tool is denied for the main agent. */
    denies(toolName: string): boolean
    /** B-922: allow / ask / deny under the safety policy (strict: never `ask`, same denies as B-916c). */
    decide(toolName: string): ToolDecision
    /** Add an exact tool name to the "always allow" set (an `ask` becomes `allow`; a `deny` stays). */
    allowAlways(toolName: string): void
    /** Extra entries to merge into SDK `disallowedTools`. */
    sdkDisallowed: string[]
}

/**
 * Build the effective denylist. `extra` = KV `deniedTools` ∪ local config
 * `deniedTools`; it can only add.
 */
export function compileOutboundDenylist(
    extra: readonly unknown[] = [],
    safety: { policy?: MainAgentSafetyPolicy; allowedTools?: readonly string[] } = {},
): CompiledDenylist {
    const policy = safety.policy ?? PRESET_POLICIES.strict
    const allowed = new Set((safety.allowedTools ?? []).map(t => t.toLowerCase()))
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
    const enabledBuiltins = new Set(assistantBuiltinsAllowedBy(policy).map(t => t.toLowerCase()))
    const builtins = new Set<string>(ASSISTANT_DISALLOWED_TOOLS.map(t => t.toLowerCase()).filter(t => !enabledBuiltins.has(t)))
    const classOf = (toolName: string, tool: string): ToolClass => {
        const lower = tool.toLowerCase()
        const tokens = toolTokens(tool)
        if (PRODUCTION_SUBSTRINGS.some(v => lower.includes(v)) || PRODUCTION_VERB_TOKENS.some(v => tokens.has(v))) return 'production'
        if (defaults.some(e => e.re.test(toolName))) return 'outbound'
        return 'thirdPartyWrite'
    }
    const decide = (toolName: string): ToolDecision => {
        if (typeof toolName !== 'string' || !toolName) return 'allow'
        if (builtins.has(toolName.toLowerCase())) return 'deny'
        if (user.some(e => e.re.test(toolName))) return 'deny'
        if (isVhOwnTool(toolName)) return 'allow'
        const tool = mcpToolPart(toolName)
        const hitsDefault = defaults.some(e => e.re.test(toolName))
        // Non-MCP names (WebFetch, Read …) only ever meet the default table, which is MCP-only.
        if (tool === null) return hitsDefault ? 'deny' : 'allow'
        const readOnly = isReadOnlyMcpTool(toolName)
        if (readOnly && !hitsDefault) return 'allow'
        const rule: ToolPolicy = policy[classOf(toolName, tool)]
        if (rule === 'deny') return 'deny'
        // "只读工具直接用": a read-only name that merely contains a verb (list_deployments) is not asked about.
        if (readOnly || rule === 'allow') return 'allow'
        return allowed.has(toolName.toLowerCase()) ? 'allow' : 'ask'
    }
    return {
        patterns: [...defaults, ...user].map(e => e.pattern),
        dropped,
        denies: (toolName: string) => decide(toolName) === 'deny',
        decide,
        allowAlways(toolName: string) { if (typeof toolName === 'string' && toolName) allowed.add(toolName.toLowerCase()) },
        sdkDisallowed: user.filter(e => isSdkNativePattern(e.pattern)).map(e => e.pattern),
    }
}

export type PreToolUseInput = { hook_event_name?: string; tool_name?: string; tool_input?: unknown; cwd?: string }
export type PreToolUseOutput = { continue: true } | {
    hookSpecificOutput: { hookEventName: 'PreToolUse'; permissionDecision: 'deny' | 'allow'; permissionDecisionReason: string }
}

/** The `ask` branch (toolApproval.ts): `allow` lets the call through, a string is the deny reason the model reads. */
export type ToolAsker = (toolName: string, toolInput: Record<string, unknown>) => Promise<'allow' | { reason: string }>

export const OWNER_APPROVED_OUTPUT: PreToolUseOutput = {
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: 'Owner 已在「需要我决策」的工具批准卡上批准了这次调用（参数一致，只放行一次）。' },
}

const denyOutput = (reason: string): PreToolUseOutput => ({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
})

/**
 * SDK `hooks.PreToolUse` callback for the main agent: deny every call the
 * list denies; an `ask` goes to `ask` (no asker = deny, fail-closed). Runs in
 * every permission mode, bypassPermissions included.
 */
export function outboundPreToolUseHook(list: Pick<CompiledDenylist, 'denies'> & Partial<Pick<CompiledDenylist, 'decide'>>, onDeny?: (toolName: string) => void, ask?: ToolAsker, protect?: ProtectedPaths) {
    return async (input: PreToolUseInput): Promise<PreToolUseOutput> => {
        if (input?.hook_event_name !== 'PreToolUse' || typeof input.tool_name !== 'string') return { continue: true }
        // B-922 (QA P2-2): credentials and the local approval records, in every preset.
        const guarded = protect?.check(input.tool_name, input.tool_input, input.cwd) ?? null
        if (guarded) { onDeny?.(input.tool_name); return denyOutput(guarded) }
        const decision: ToolDecision = list.decide ? list.decide(input.tool_name) : list.denies(input.tool_name) ? 'deny' : 'allow'
        if (decision === 'allow') return { continue: true }
        if (decision === 'ask' && ask) {
            const toolInput = input.tool_input && typeof input.tool_input === 'object' && !Array.isArray(input.tool_input) ? input.tool_input as Record<string, unknown> : {}
            let verdict: 'allow' | { reason: string }
            try { verdict = await ask(input.tool_name, toolInput) } catch { verdict = { reason: TOOL_APPROVAL_UNAVAILABLE_REASON } }
            // B-924g (e2e on 9604d2b70): the owner already approved this exact call on the card — say so to Claude
            // Code, or its own permission prompt asks the owner a second time (permissionMode default).
            if (verdict === 'allow') return OWNER_APPROVED_OUTPUT
            onDeny?.(input.tool_name)
            return denyOutput(verdict.reason)
        }
        onDeny?.(input.tool_name)
        return denyOutput(OUTBOUND_DENY_REASON)
    }
}

export const TOOL_APPROVAL_UNAVAILABLE_REASON = '这个工具需要 Owner 批准，但汇报板现在不可用，所以没有执行。'
    + ' (This tool needs the owner\'s approval and the decision board is unavailable; nothing was run.)'
