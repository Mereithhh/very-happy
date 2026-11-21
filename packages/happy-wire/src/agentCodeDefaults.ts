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

import { LATEST_MODEL_MODE } from './modelLatest';

export const AGENT_KEYS = ['claude', 'codex', 'gemini', 'openclaw', 'pi', 'dsh'] as const;
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

/**
 * B-907: Fable 5.2 first ships in claude-agent-sdk 0.3.322 (Claude Code
 * 2.1.322: known model, `fable` alias → claude-fable-5-2). Wrappers on that
 * SDK advertise this capability; the picker offers the pinned id in a live
 * session only then. An older Claude Code still runs the id when asked
 * (`--model` / `setModel`, probed 2026-11-10 on 2.1.318 via an API-key
 * provider: an `unrecognized_model` warning, 200k context) — so the
 * capability gates what we list, not what a session may run.
 */
export const CLAUDE_FABLE_52_MODEL = 'claude-fable-5-2';
export const CLAUDE_FABLE_52_CAPABILITY = 'claude-fable-5-2-v1';

export function supportsClaudeFable52(metadata: { capabilities?: string[] | null } | null | undefined): boolean {
    return metadata?.capabilities?.includes(CLAUDE_FABLE_52_CAPABILITY) === true;
}

/**
 * B-949: Sonnet 5.5 and Haiku 5.5 as pinned ids. Claude Code 2.1.330
 * (claude-agent-sdk 0.3.330) resolves `sonnet` / `haiku` to them and runs
 * `claude-sonnet-5-5`, `claude-sonnet-5-5[1m]` and `claude-haiku-5-5` (probed
 * 2026-11-21). Wrappers on that SDK advertise these capabilities; the picker
 * lists the pinned ids in a live session only then — an older wrapper simply
 * does not see them. No `claude-haiku-5-5[1m]`: 2.1.330's catalog has no 1M
 * twin for Haiku (the marker is accepted and dropped).
 */
export const CLAUDE_SONNET_55_MODEL = 'claude-sonnet-5-5';
export const CLAUDE_SONNET_55_CAPABILITY = 'claude-sonnet-5-5-v1';
export const CLAUDE_HAIKU_55_MODEL = 'claude-haiku-5-5';
export const CLAUDE_HAIKU_55_CAPABILITY = 'claude-haiku-5-5-v1';

export function supportsClaudeSonnet55(metadata: { capabilities?: string[] | null } | null | undefined): boolean {
    return metadata?.capabilities?.includes(CLAUDE_SONNET_55_CAPABILITY) === true;
}

export function supportsClaudeHaiku55(metadata: { capabilities?: string[] | null } | null | undefined): boolean {
    return metadata?.capabilities?.includes(CLAUDE_HAIKU_55_CAPABILITY) === true;
}

export const AGENT_CODE_DEFAULTS: Readonly<Record<AgentKey, AgentDefaultConfig>> = {
    // The Claude UI key for YOLO is `bypassPermissions`; the CLI also accepts
    // `yolo` and maps it to the Claude SDK's bypass mode.
    // model: `latest` (B-844) = the newest model of the agent's tier that the
    // session's wrapper can run, resolved at send time (modelLatest.ts) and
    // never sent as is. Today: Claude → claude-opus-5-5 (pinned id, not the
    // `opus` alias), Codex → gpt-6.2-sol on Codex >= 0.169.1 (gpt-6.1-sol on >= 0.160), Gemini → the
    // newest pro its session catalog lists. effort null = don't send effort.
    claude: { permissionMode: 'bypassPermissions', modelMode: LATEST_MODEL_MODE, effortLevel: null },
    codex: { permissionMode: 'yolo', modelMode: LATEST_MODEL_MODE, effortLevel: 'medium' },
    gemini: { permissionMode: 'default', modelMode: LATEST_MODEL_MODE, effortLevel: null },
    openclaw: { permissionMode: 'default', modelMode: 'default', effortLevel: null },
    // pi: the runner keeps Claude's permission vocabulary (B-350 — HAPPY_PERMISSION_MODE +
    // session-modes file, enforced by the pi-side gate; `bypassPermissions` = auto-allow every
    // ask rule), so yolo is the same key as for Claude. Model 'default' = don't send a model:
    // the session runs on whatever the machine's pi is configured with (pi-acp publishes
    // its own registry in metadata.models plus the model really in effect in
    // metadata.currentModelCode, B-362). Thinking levels follow the session
    // catalog and travel through ACP config options, independently of permissions.
    pi: { permissionMode: 'bypassPermissions', modelMode: 'default', effortLevel: null },
    // B-952 dsh (DeepSeek Harness, `dsh --profile acp`): no ACP permission modes, so
    // Very Happy asks for every tool unless the session runs yolo (`bypassPermissions`,
    // auto-approved by the runner). Model / reasoning effort come from dsh's own ACP
    // config options; 'default' = whatever dsh is configured with.
    dsh: { permissionMode: 'default', modelMode: 'default', effortLevel: null },
};

/**
 * Launcher agent key ↔ session flavor. The launcher spawns `agent: 'pi'`, but the
 * CLI records a pi session as `metadata.flavor === 'acp'` (runAcp's
 * resolveSessionFlavor: gemini → 'gemini', opencode → 'opencode', anything else
 * → 'acp'). pi is the only ACP agent the web offers, so both spellings resolve
 * to the same defaults slot.
 */
export function normalizeAgentKey(flavor: string | null | undefined): AgentKey {
    if (flavor === 'codex' || flavor === 'gemini' || flavor === 'openclaw' || flavor === 'pi' || flavor === 'dsh') {
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
