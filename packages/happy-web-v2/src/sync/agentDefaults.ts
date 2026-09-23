import * as z from 'zod';

// Every agent the launcher can spawn, each with its own defaults slot. `pi` is
// first-class (B-370): before it was folded into `claude`, so the settings page
// offered Claude aliases (opus/sonnet/fable) as pi's model list and a model
// picked inside a pi session was written into agentDefaultOverrides.claude.
export const agentKeys = ['claude', 'codex', 'gemini', 'openclaw', 'pi'] as const;
export type AgentKey = typeof agentKeys[number];

export const AgentDefaultOverrideSchema = z.object({
    permissionMode: z.string().optional(),
    modelMode: z.string().optional(),
    effortLevel: z.string().optional(),
}).passthrough();

export const AgentDefaultOverridesSchema = z.object({
    claude: AgentDefaultOverrideSchema.optional(),
    codex: AgentDefaultOverrideSchema.optional(),
    gemini: AgentDefaultOverrideSchema.optional(),
    openclaw: AgentDefaultOverrideSchema.optional(),
    // `.optional()`, never `.default()` (rule 1). Old web bundles don't know the
    // key but `.passthrough()` keeps it when they re-POST the object.
    pi: AgentDefaultOverrideSchema.optional(),
}).passthrough().default({});

export type AgentDefaultOverride = z.infer<typeof AgentDefaultOverrideSchema>;
export type AgentDefaultOverrides = z.infer<typeof AgentDefaultOverridesSchema>;
export type AgentDefaultField = keyof Pick<AgentDefaultOverride, 'permissionMode' | 'modelMode' | 'effortLevel'>;

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

const codeAgentDefaults: Record<AgentKey, AgentDefaultConfig> = {
    // The Claude UI key for YOLO is `bypassPermissions`; the CLI also accepts
    // `yolo` and maps it to the Claude SDK's bypass mode.
    // model defaults to the pinned Opus 5.5 id (not the `opus` alias, whose
    // target depends on the wrapper's bundled Claude Code). Wrappers that
    // cannot run it fall back to 'default' via resolveDefaultModelMode.
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
 * to the same defaults slot — otherwise a running pi session would read and
 * WRITE Claude's defaults while the launcher used pi's.
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

export function isPiAgent(flavor: string | null | undefined): boolean {
    return normalizeAgentKey(flavor) === 'pi';
}

export function getCodeAgentDefaults(flavor: string | null | undefined): AgentDefaultConfig {
    return codeAgentDefaults[normalizeAgentKey(flavor)];
}

// Review-first permission mode per agent: the agent proposes changes and waits
// for approval before applying them, rather than auto-applying. Used by the
// device-local "new session review-first" safety toggle. Keys must match the
// permission mode keys in components/modelModeOptions.ts.
const reviewFirstPermissionModes: Record<AgentKey, string> = {
    claude: 'plan',
    codex: 'read-only',
    gemini: 'plan',
    openclaw: 'default',
    // The official pi gate asks before write operations in default mode.
    pi: 'default',
};

export function getReviewFirstPermissionMode(flavor: string | null | undefined): string {
    return reviewFirstPermissionModes[normalizeAgentKey(flavor)];
}

export function resolveNewSessionPermissionMode(
    overrides: AgentDefaultOverrides | null | undefined,
    flavor: string | null | undefined,
    reviewFirst: boolean,
): string {
    // pi uses the shared permission keys and an official runtime gate, with
    // its own defaults slot. The session reports the selected effective mode.
    const explicitDefault = getAgentDefaultOverride(overrides, flavor).permissionMode;
    if (explicitDefault !== undefined) {
        return explicitDefault;
    }
    return reviewFirst
        ? getReviewFirstPermissionMode(flavor)
        : getCodeAgentDefaults(flavor).permissionMode;
}

export function getAgentDefaultOverride(
    overrides: AgentDefaultOverrides | null | undefined,
    flavor: string | null | undefined,
): AgentDefaultOverride {
    return overrides?.[normalizeAgentKey(flavor)] ?? {};
}

export function resolveAgentDefaultConfig(
    overrides: AgentDefaultOverrides | null | undefined,
    flavor: string | null | undefined,
): AgentDefaultConfig {
    const codeDefaults = getCodeAgentDefaults(flavor);
    const userOverride = getAgentDefaultOverride(overrides, flavor);
    return {
        permissionMode: userOverride.permissionMode ?? codeDefaults.permissionMode,
        modelMode: userOverride.modelMode ?? codeDefaults.modelMode,
        effortLevel: userOverride.effortLevel ?? codeDefaults.effortLevel,
    };
}

/**
 * Model a session runs when nobody picked one for it: the synced per-agent
 * override, else the code default. Picking a model in any session also writes
 * the override, so pinned Opus 5.5 can arrive from either source; a session
 * whose wrapper cannot run it follows the machine's own default instead of
 * failing every turn. Without session metadata (launcher, settings) the value
 * is shown as is.
 */
export function resolveDefaultModelMode(
    overrides: AgentDefaultOverrides | null | undefined,
    flavor: string | null | undefined,
    metadata?: { capabilities?: string[] | null } | null,
): string {
    const selected = getAgentDefaultOverride(overrides, flavor).modelMode ?? getCodeAgentDefaults(flavor).modelMode;
    if (isClaudeOpus55Model(selected) && metadata && !supportsClaudeOpus55(metadata)) return 'default';
    return selected;
}

function isClaudeOpus55Model(model: string): boolean {
    return model === CLAUDE_OPUS_55_MODEL || model === `${CLAUDE_OPUS_55_MODEL}[1m]`;
}

export function hasAgentDefaultOverride(
    overrides: AgentDefaultOverrides | null | undefined,
    flavor: string | null | undefined,
    field: AgentDefaultField,
): boolean {
    return getAgentDefaultOverride(overrides, flavor)[field] !== undefined;
}

export function getAgentDefaultOverrideValue(
    overrides: AgentDefaultOverrides | null | undefined,
    flavor: string | null | undefined,
    field: AgentDefaultField,
): string | undefined {
    return getAgentDefaultOverride(overrides, flavor)[field];
}

export function setAgentDefaultOverride(
    overrides: AgentDefaultOverrides | null | undefined,
    flavor: string | null | undefined,
    field: AgentDefaultField,
    value: string | null | undefined,
): AgentDefaultOverrides {
    const key = normalizeAgentKey(flavor);
    const next: AgentDefaultOverrides = { ...(overrides ?? {}) };
    const current: AgentDefaultOverride = { ...(next[key] ?? {}) };

    if (value === null || value === undefined) {
        delete current[field];
    } else {
        current[field] = value;
    }

    if (current.permissionMode === undefined && current.modelMode === undefined && current.effortLevel === undefined) {
        delete next[key];
    } else {
        next[key] = current;
    }

    return next;
}
