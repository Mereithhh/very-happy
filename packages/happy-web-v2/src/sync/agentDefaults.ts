import * as z from 'zod';

// Every agent the launcher can spawn, each with its own defaults slot. `pi` is
// first-class (B-370): before it was folded into `claude`, so the settings page
// offered Claude aliases (opus/sonnet/fable) as pi's model list and a model
// picked inside a pi session was written into agentDefaultOverrides.claude.
// The key list and the code defaults below live in happy-wire so
// `very-happy spawn` starts sessions exactly like the launcher (B-492).
import {
    AGENT_KEYS,
    AGENT_CODE_DEFAULTS,
    CLAUDE_OPUS_55_MODEL,
    CLAUDE_OPUS_55_CAPABILITY,
    supportsClaudeOpus55,
    isClaudeOpus55Model,
    normalizeAgentKey,
    type AgentKey,
    type AgentDefaultConfig,
} from '@slopus/happy-wire';
export { CLAUDE_OPUS_55_MODEL, CLAUDE_OPUS_55_CAPABILITY, supportsClaudeOpus55, normalizeAgentKey };
export type { AgentKey, AgentDefaultConfig };
export const agentKeys = AGENT_KEYS;

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

export function isPiAgent(flavor: string | null | undefined): boolean {
    return normalizeAgentKey(flavor) === 'pi';
}

export function getCodeAgentDefaults(flavor: string | null | undefined): AgentDefaultConfig {
    return AGENT_CODE_DEFAULTS[normalizeAgentKey(flavor)];
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
