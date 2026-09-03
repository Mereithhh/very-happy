import * as z from 'zod';

export const agentKeys = ['claude', 'codex', 'gemini', 'openclaw'] as const;
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
}).passthrough().default({});

export type AgentDefaultOverride = z.infer<typeof AgentDefaultOverrideSchema>;
export type AgentDefaultOverrides = z.infer<typeof AgentDefaultOverridesSchema>;
export type AgentDefaultField = keyof Pick<AgentDefaultOverride, 'permissionMode' | 'modelMode' | 'effortLevel'>;

export type AgentDefaultConfig = {
    permissionMode: string;
    modelMode: string;
    effortLevel: string | null;
};

const codeAgentDefaults: Record<AgentKey, AgentDefaultConfig> = {
    // The Claude UI key for YOLO is `bypassPermissions`; the CLI also accepts
    // `yolo` and maps it to the Claude SDK's bypass mode.
    // model/effort default to the CLI's own local config ('default' = don't
    // pass a model; effort null = don't send effort) so a new chat follows
    // whatever the machine's `claude` is configured with (e.g. /model there).
    claude: { permissionMode: 'bypassPermissions', modelMode: 'default', effortLevel: null },
    codex: { permissionMode: 'yolo', modelMode: 'gpt-5.5', effortLevel: 'medium' },
    gemini: { permissionMode: 'default', modelMode: 'gemini-2.5-pro', effortLevel: null },
    openclaw: { permissionMode: 'default', modelMode: 'default', effortLevel: null },
};

export function normalizeAgentKey(flavor: string | null | undefined): AgentKey {
    if (flavor === 'codex' || flavor === 'gemini' || flavor === 'openclaw') {
        return flavor;
    }
    return 'claude';
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
};

export function getReviewFirstPermissionMode(flavor: string | null | undefined): string {
    return reviewFirstPermissionModes[normalizeAgentKey(flavor)];
}

export function resolveNewSessionPermissionMode(
    overrides: AgentDefaultOverrides | null | undefined,
    flavor: string | null | undefined,
    reviewFirst: boolean,
): string {
    // pi follows the Claude keys on purpose: since the pi runner keeps
    // --permission-mode (HAPPY_PERMISSION_MODE + session-modes file, B-349) the
    // vh-supervisor permission gate enforces `bypassPermissions` as "auto-allow
    // every ask rule" and `default` as "ask becomes a permission card"; hard deny
    // rules are never lifted. `plan`/`acceptEdits` are treated as `default` by
    // the gate. The CLI publishes the value really in effect in
    // metadata.permissionMode (rule 14), so what the launcher records is the
    // intent and the session row shows the fact.
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
