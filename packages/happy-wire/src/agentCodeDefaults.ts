/**
 * Code defaults for a NEW session, per agent — the single source shared by the
 * web launcher and `very-happy spawn` (B-492).
 *
 * Before this lived only in happy-web-v2 (`sync/agentDefaults.ts`), so a
 * session spawned from the CLI ran in `default` permission mode on whatever
 * model the machine's Claude Code picked, while the same spawn from the web
 * ran yolo on Opus 5.5. Both surfaces now read this table. Account-level
 * overrides (`agentDefaultOverrides`, synced settings) stay web-only: they are
 * encrypted with the account content key, which `dataKey` CLI credentials do
 * not hold.
 */

export const AGENT_KEYS = ['claude', 'codex', 'gemini', 'openclaw', 'pi'] as const;
export type AgentKey = typeof AGENT_KEYS[number];

export type AgentDefaultConfig = {
    permissionMode: string;
    modelMode: string;
    effortLevel: string | null;
};

/**
 * Opus 5.5 needs Claude Code >= 2.1.280: older bundled CLIs get a 400
 * "version 2.1.280 or newer is required" (probed on SDK 0.3.267, 2026-09-24).
 * Wrappers on SDK >= 0.3.281 advertise this capability at spawn, before the
 * first SDK response publishes their model catalog.
 */
export const CLAUDE_OPUS_55_MODEL = 'claude-opus-5-5';
export const CLAUDE_OPUS_55_CAPABILITY = 'claude-opus-5-5-v1';

export function supportsClaudeOpus55(metadata: { capabilities?: string[] | null } | null | undefined): boolean {
    return metadata?.capabilities?.includes(CLAUDE_OPUS_55_CAPABILITY) === true;
}

export function isClaudeOpus55Model(model: string): boolean {
    return model === CLAUDE_OPUS_55_MODEL || model === `${CLAUDE_OPUS_55_MODEL}[1m]`;
}

export const AGENT_CODE_DEFAULTS: Readonly<Record<AgentKey, AgentDefaultConfig>> = {
    // The Claude UI key for YOLO is `bypassPermissions`; the CLI also accepts
    // `yolo` and maps it to the Claude SDK's bypass mode.
    // model defaults to the pinned Opus 5.5 id (not the `opus` alias, whose
    // target depends on the wrapper's bundled Claude Code). Wrappers that
    // cannot run it fall back to 'default' (see supportsClaudeOpus55).
    // effort null = don't send effort.
    claude: { permissionMode: 'bypassPermissions', modelMode: CLAUDE_OPUS_55_MODEL, effortLevel: null },
    codex: { permissionMode: 'yolo', modelMode: 'gpt-5.5', effortLevel: 'medium' },
    gemini: { permissionMode: 'default', modelMode: 'gemini-2.5-pro', effortLevel: null },
    openclaw: { permissionMode: 'default', modelMode: 'default', effortLevel: null },
    // pi: the runner keeps Claude's permission vocabulary (B-350 — HAPPY_PERMISSION_MODE +
    // session-modes file, enforced by the pi-side gate; `bypassPermissions` = auto-allow every
    // ask rule), so yolo is the same key as for Claude. Model 'default' = don't send a model:
    // the session runs on whatever the machine's pi is configured with (pi-acp publishes
    // its own registry in metadata.models plus the model really in effect in
    // metadata.currentModelCode, B-362). Thinking levels follow the session
    // catalog and travel through ACP config options, independently of permissions.
    pi: { permissionMode: 'bypassPermissions', modelMode: 'default', effortLevel: null },
};

/**
 * Launcher agent key ↔ session flavor. The launcher spawns `agent: 'pi'`, but the
 * CLI records a pi session as `metadata.flavor === 'acp'` (runAcp's
 * resolveSessionFlavor: gemini → 'gemini', opencode → 'opencode', anything else
 * → 'acp'). pi is the only ACP agent the web offers, so both spellings resolve
 * to the same defaults slot.
 */
export function normalizeAgentKey(flavor: string | null | undefined): AgentKey {
    if (flavor === 'codex' || flavor === 'gemini' || flavor === 'openclaw' || flavor === 'pi') {
        return flavor;
    }
    if (flavor === 'acp') {
        return 'pi';
    }
    return 'claude';
}

export function getAgentCodeDefaults(flavor: string | null | undefined): AgentDefaultConfig {
    return AGENT_CODE_DEFAULTS[normalizeAgentKey(flavor)];
}
