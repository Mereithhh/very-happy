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
    isLatestModelMode,
    normalizeAgentKey,
    resolveLatestModel,
    type AgentKey,
    type AgentDefaultConfig,
    type CatalogEntryLike,
    type LatestModelContext,
    type LatestModelResolution,
    type LatestModelTable,
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

/** What the launcher knows about the machine a new session will run on. */
export type LauncherMachineContext = {
    cliVersion?: string | null;
    /** Installed version of the agent CLI (codex) from daemonState.agentVersions. */
    agentVersion?: string | null;
    /** Catalog a recent session of this agent on this machine published. */
    catalog?: readonly CatalogEntryLike[] | null;
};

export type ModelResolveMetadata = {
    capabilities?: string[] | null;
    models?: readonly CatalogEntryLike[] | null;
};

/**
 * Where `latest` is resolved (B-844): a live session decides by its own
 * capabilities and catalog; without one, the launcher machine's versions and
 * recent catalog only pick the label; with neither, the newest known model.
 */
export function latestModelContext(
    metadata: ModelResolveMetadata | null | undefined,
    machine?: LauncherMachineContext | null,
): LatestModelContext {
    if (metadata) return { kind: 'session', capabilities: metadata.capabilities ?? null, catalog: metadata.models ?? null };
    if (machine) return { kind: 'machine', cliVersion: machine.cliVersion ?? null, agentVersion: machine.agentVersion ?? null, catalog: machine.catalog ?? null };
    return { kind: 'none' };
}

export function resolveLatestForAgent(
    table: LatestModelTable | null | undefined,
    flavor: string | null | undefined,
    metadata: ModelResolveMetadata | null | undefined,
    machine?: LauncherMachineContext | null,
): LatestModelResolution {
    return resolveLatestModel(table, normalizeAgentKey(flavor), latestModelContext(metadata, machine));
}

/** The account default for this agent is "follow latest" (no pinned model). */
export function isFollowingLatestModel(
    overrides: AgentDefaultOverrides | null | undefined,
    flavor: string | null | undefined,
): boolean {
    const selected = getAgentDefaultOverride(overrides, flavor).modelMode ?? getCodeAgentDefaults(flavor).modelMode;
    return isLatestModelMode(selected);
}

/**
 * Model a session runs when nobody picked one for it: the synced per-agent
 * override, else the code default `latest` resolved for this wrapper (B-844)
 * — a concrete id, or 'default' (machine default) when nothing is provably
 * runnable. A pinned Opus 5.5 override on a wrapper that cannot run it also
 * follows the machine default instead of failing every turn. Without session
 * metadata (launcher, settings) `machine` narrows the label; never returns
 * the sentinel itself.
 */
export function resolveDefaultModelMode(
    overrides: AgentDefaultOverrides | null | undefined,
    flavor: string | null | undefined,
    metadata?: ModelResolveMetadata | null,
    opts?: { table?: LatestModelTable | null; machine?: LauncherMachineContext | null },
): string {
    const selected = getAgentDefaultOverride(overrides, flavor).modelMode ?? getCodeAgentDefaults(flavor).modelMode;
    if (isLatestModelMode(selected)) {
        return resolveLatestForAgent(opts?.table, flavor, metadata, opts?.machine).model ?? 'default';
    }
    if (isClaudeOpus55Model(selected) && metadata && !supportsClaudeOpus55(metadata)) return 'default';
    return selected;
}

/**
 * Override to store after a model is picked inside a session (B-844): the
 * model "latest" currently resolves to there means "keep following latest"
 * (clear the override) — only another model is remembered as the account
 * default. Pinning the current latest is an explicit Settings → Agents act.
 */
export function modelOverrideAfterSessionPick(
    flavor: string | null | undefined,
    key: string | null,
    resolvedLatest: string | null,
): string | null {
    if (key === null) return null;
    if (isLatestModelMode(getCodeAgentDefaults(flavor).modelMode) && resolvedLatest !== null && key === resolvedLatest) return null;
    return key;
}

/**
 * One-time migration (B-844): before "follow latest", picking a model in any
 * session wrote it as the account default, so most stored model overrides
 * equal what was newest when they were written. Those that equal today's
 * latest (frozen below — later table updates must not re-migrate) become
 * "follow latest"; any other override is a real choice and stays.
 */
export const FOLLOW_LATEST_MIGRATION_MODELS: Readonly<Partial<Record<AgentKey, readonly string[]>>> = {
    claude: ['claude-opus-5-5'],
    codex: ['gpt-6.1-sol'],
    gemini: ['gemini-3.1-pro-preview'],
};

export function migrateFollowLatestOverrides(
    overrides: AgentDefaultOverrides | null | undefined,
    migratedAt: number | null | undefined,
    now: number,
): { agentDefaultOverrides?: AgentDefaultOverrides; modelFollowLatestMigratedAt: number } | null {
    if (typeof migratedAt === 'number') return null;
    let next: AgentDefaultOverrides = overrides ?? {};
    let changed = false;
    for (const [agent, models] of Object.entries(FOLLOW_LATEST_MIGRATION_MODELS) as Array<[AgentKey, readonly string[]]>) {
        const current = getAgentDefaultOverride(next, agent).modelMode;
        if (current !== undefined && models.includes(current)) {
            next = setAgentDefaultOverride(next, agent, 'modelMode', null);
            changed = true;
        }
    }
    return changed
        ? { agentDefaultOverrides: next, modelFollowLatestMigratedAt: now }
        : { modelFollowLatestMigratedAt: now };
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
