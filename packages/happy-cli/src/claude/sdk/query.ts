/**
 * Query wrapper around official @anthropic-ai/claude-agent-sdk
 * Maps internal QueryOptions to official SDK Options
 */

import { query as sdkQuery, type Options, type Query } from '@anthropic-ai/claude-agent-sdk'
import type { QueryOptions, QueryPrompt } from './types'
import { ensureLocalProxyBypass } from '../utils/proxyBypass'
import { pinSmallFastModel } from '../utils/smallFastModel'
import { resolveHappyEntrypoint } from './happyEntrypoint'

/**
 * Wraps the official SDK query() with our QueryOptions adapter
 */
export function query(params: { prompt: QueryPrompt; options?: QueryOptions }): Query {
    const opts = params.options

    // Build system prompt
    let systemPrompt: Options['systemPrompt'] = undefined
    if (opts?.customSystemPrompt) {
        systemPrompt = opts.customSystemPrompt
    } else if (opts?.appendSystemPrompt) {
        systemPrompt = {
            type: 'preset',
            preset: 'claude_code',
            append: opts.appendSystemPrompt
        }
    }

    // Map QueryOptions -> official Options
    const sdkOptions: Options = {
        cwd: opts?.cwd,
        additionalDirectories: opts?.additionalDirectories,
        resume: opts?.resume,
        continue: opts?.continue,
        model: opts?.model,
        fallbackModel: opts?.fallbackModel,
        maxTurns: opts?.maxTurns,
        permissionMode: opts?.permissionMode,
        allowDangerouslySkipPermissions: opts?.allowDangerouslySkipPermissions
            ?? opts?.permissionMode === 'bypassPermissions',
        allowedTools: opts?.allowedTools,
        disallowedTools: opts?.disallowedTools,
        mcpServers: opts?.mcpServers as Options['mcpServers'],
        systemPrompt,
        settings: opts?.settingsPath,
        // Load filesystem settings the way the real `claude` CLI does. The
        // agent SDK does NOT load these by default (the rename from
        // @anthropic-ai/claude-code flipped the default to "isolated" — the
        // sdk.d.ts comment claiming "omitted = all sources" is stale), so a
        // remote/web session would otherwise ignore ~/.claude/CLAUDE.md, the
        // project .claude/, AND skills (skills are discovered from these dirs).
        // 'user' brings in the global CLAUDE.md (e.g. "reply in Chinese"),
        // 'project'/'local' bring in repo-level CLAUDE.md + settings → parity
        // with a plain CLI invocation. This is the whole point of running our
        // own fork: remote sessions should behave like local ones.
        settingSources: ['user', 'project', 'local'],
        strictMcpConfig: opts?.strictMcpConfig,
        sessionId: undefined,
        effort: opts?.effort,
        forkSession: opts?.forkSession,
        tools: opts?.tools,
        persistSession: opts?.persistSession,
        includePartialMessages: opts?.includePartialMessages,
        onElicitation: opts?.onElicitation,
        onUserDialog: opts?.onUserDialog,
        supportedDialogKinds: opts?.onUserDialog ? opts.supportedDialogKinds : undefined,
    }

    // Map abort signal -> AbortController
    if (opts?.abort) {
        const controller = new AbortController()
        if (opts.abort.aborted) {
            controller.abort(opts.abort.reason)
        } else {
            opts.abort.addEventListener('abort', () => controller.abort(opts.abort?.reason), { once: true })
        }
        sdkOptions.abortController = controller
    }

    // Build env: tag the spawned Claude with an entrypoint that is NOT in
    // Claude Code's `--resume` picker filter set ({sdk-cli, sdk-ts, sdk-py}),
    // so sessions Happy starts/continues remain visible to a plain
    // `claude --resume` picker. The agent SDK would otherwise default to
    // CLAUDE_CODE_ENTRYPOINT="sdk-ts" and the picker would hide every Happy
    // session. See slopus/happy#1202.
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(process.env)) {
        if (typeof value === 'string') env[key] = value
    }
    for (const [key, value] of Object.entries(opts?.env ?? {})) {
        if (typeof value === 'string') env[key] = value
    }
    env.CLAUDE_CODE_ENTRYPOINT = resolveHappyEntrypoint(env.CLAUDE_CODE_ENTRYPOINT)
    // Keep background/utility calls (built-in session-title generation etc.)
    // on haiku instead of the session's main model. Main model is unaffected.
    pinSmallFastModel(env)
    if (opts?.mcpServers && Object.keys(opts.mcpServers).length > 0) {
        ensureLocalProxyBypass(env)
    }
    // Claude Code refuses `--dangerously-skip-permissions` under root/sudo
    // ("cannot be used with root/sudo privileges for security reasons") unless
    // it believes it is sandboxed (IS_SANDBOX). Remote/web sessions ALWAYS pass
    // the SDK dangerous opt-in (claudeRemote sets allowDangerouslySkipPermissions
    // so a live switch to bypass can succeed — the effective policy is still
    // enforced by permissionMode/canUseTool), so on a daemon running as root
    // EVERY spawn — default permission mode included — otherwise dies instantly
    // and the web shows "Agent 进程意外退出". These daemons routinely run as root
    // on disposable rollout VMs; when we already requested the opt-in and are
    // actually root, assert the sandbox so the process can start. Never override
    // an explicit IS_SANDBOX (the operator's own choice, e.g. "0" to forbid).
    if (sdkOptions.allowDangerouslySkipPermissions
        && typeof process.getuid === 'function'
        && process.getuid() === 0
        && env.IS_SANDBOX === undefined) {
        env.IS_SANDBOX = '1'
    }
    sdkOptions.env = env

    // Map canCallTool -> canUseTool
    if (opts?.canCallTool) {
        const callback = opts.canCallTool
        sdkOptions.canUseTool = async (toolName, input, options) => {
            return callback(toolName, input, options)
        }
    }

    return sdkQuery({
        prompt: params.prompt,
        options: sdkOptions,
    })
}
