/**
 * What `very-happy spawn` sends so a CLI-spawned session starts exactly like
 * one created in the web launcher (B-492). Pure; unit-tested.
 *
 * The web decides two things for a fresh session:
 * 1. the spawn permission mode — the per-agent code default (claude: yolo),
 *    passed to the daemon as `--permission-mode`;
 * 2. the first message's meta — `resolveMessageModeMeta` in
 *    happy-web-v2/src/sync/messageMeta.ts with no session state and no
 *    account overrides: claude always carries `model` (Opus 5.5, or null =
 *    machine default when the wrapper cannot run it) and `effort: null`;
 *    other agents carry only the permission mode.
 * Both read AGENT_CODE_DEFAULTS from happy-wire, the table the web uses.
 * Account-level overrides (synced settings) are not applied here: they are
 * encrypted with the account content key, which dataKey CLI credentials lack.
 */

import {
    getAgentCodeDefaults,
    isClaudeOpus55Model,
    normalizeAgentKey,
    supportsClaudeOpus55,
} from '@slopus/happy-wire'

export interface FirstMessageMeta {
    permissionMode?: string
    /** null = reset to the machine's own default model. */
    model?: string | null
    effort?: string | null
}

/** Explicit `--permission-mode` wins; otherwise the web launcher's code default. */
export function resolveSpawnPermissionMode(agent: string | undefined, explicit: string | undefined): string {
    return explicit ?? getAgentCodeDefaults(agent ?? 'claude').permissionMode
}

/** Claude (and pi, which shares its vocabulary) spells yolo `bypassPermissions` on the wire. */
function outboundPermissionMode(agent: string | undefined, mode: string): string {
    const key = normalizeAgentKey(agent ?? 'claude')
    if ((key === 'claude' || key === 'pi') && mode === 'yolo') return 'bypassPermissions'
    return mode
}

/**
 * Meta for the first user message of a freshly spawned (or forked) session.
 * `capabilities` are the new session's advertised wrapper capabilities (from
 * its metadata); `explicitModel` is `--model` ('default' = machine default).
 */
export function resolveFirstMessageMeta(input: {
    agent: string | undefined
    permissionMode: string
    explicitModel?: string
    capabilities?: string[] | null
}): FirstMessageMeta {
    const meta: FirstMessageMeta = {
        permissionMode: outboundPermissionMode(input.agent, input.permissionMode),
    }
    if (input.explicitModel !== undefined) {
        meta.model = input.explicitModel === 'default' ? null : input.explicitModel
    }
    if (normalizeAgentKey(input.agent ?? 'claude') !== 'claude') return meta

    if (meta.model === undefined) {
        const model = getAgentCodeDefaults('claude').modelMode
        const runnable = !isClaudeOpus55Model(model) || supportsClaudeOpus55({ capabilities: input.capabilities ?? null })
        meta.model = runnable && model !== 'default' ? model : null
    }
    meta.effort = null
    return meta
}
