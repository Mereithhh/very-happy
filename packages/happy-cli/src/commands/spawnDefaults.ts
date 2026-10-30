/**
 * What `very-happy spawn` sends so a CLI-spawned session starts exactly like
 * one created in the web launcher (B-492). Pure; unit-tested.
 *
 * The web decides two things for a fresh session:
 * 1. the spawn permission mode — the per-agent code default (claude: yolo),
 *    passed to the daemon as `--permission-mode`;
 * 2. the first message's meta — `resolveMessageModeMeta` in
 *    happy-web-v2/src/sync/messageMeta.ts with no session state and no
 *    account overrides: claude always carries `model` (the code default
 *    `latest` resolved for this wrapper — B-844 — or null = machine default
 *    when it can run no known Opus) and `effort: null`; codex/gemini carry
 *    the resolved `latest` model when their published catalog proves one,
 *    else only the permission mode.
 * Both read AGENT_CODE_DEFAULTS from happy-wire, the table the web uses, and
 * resolve `latest` against the server's latest-models table (bundled copy as
 * fallback) — `latest` itself is never sent.
 * Account-level overrides (synced settings) are not applied here: they are
 * encrypted with the account content key, which dataKey CLI credentials lack.
 */

import {
    getAgentCodeDefaults,
    isLatestModelMode,
    normalizeAgentKey,
    resolveLatestModel,
    type CatalogEntryLike,
    type LatestModelTable,
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
 * `capabilities` / `catalog` are the new session's advertised wrapper
 * capabilities and published model catalog (from its metadata);
 * `explicitModel` is `--model` ('default' = machine default, 'latest' =
 * follow latest); `latestTable` is the server's table (null = bundled).
 */
export function resolveFirstMessageMeta(input: {
    agent: string | undefined
    permissionMode: string
    explicitModel?: string
    capabilities?: string[] | null
    catalog?: readonly CatalogEntryLike[] | null
    /** metadata.configuredModel: string = pinned by the machine's agent config, null = none, undefined = unknown. */
    configuredModel?: string | null
    latestTable?: LatestModelTable | null
}): FirstMessageMeta {
    const meta: FirstMessageMeta = {
        permissionMode: outboundPermissionMode(input.agent, input.permissionMode),
    }
    const key = normalizeAgentKey(input.agent ?? 'claude')
    const wanted = input.explicitModel ?? getAgentCodeDefaults(key).modelMode
    if (isLatestModelMode(wanted)) {
        const resolved = resolveLatestModel(input.latestTable, key, {
            kind: 'session',
            capabilities: input.capabilities ?? null,
            catalog: input.catalog ?? null,
            configuredModel: input.configuredModel,
        }).model
        // Claude always states its model (null = machine default); the others
        // only send one their catalog proves, otherwise the machine decides.
        if (resolved) meta.model = resolved
        else if (key === 'claude' || input.explicitModel !== undefined) meta.model = null
    } else if (input.explicitModel !== undefined) {
        meta.model = input.explicitModel === 'default' ? null : input.explicitModel
    } else if (key === 'claude') {
        meta.model = wanted === 'default' ? null : wanted
    }
    if (key === 'claude') meta.effort = null
    return meta
}

/** Agents whose `latest` resolves from the catalog the wrapper publishes after connecting. */
export function waitsForModelCatalog(agent: string | undefined, explicitModel: string | undefined): boolean {
    const key = normalizeAgentKey(agent ?? 'claude')
    if (key !== 'codex' && key !== 'gemini') return false
    return isLatestModelMode(explicitModel ?? getAgentCodeDefaults(key).modelMode)
}
