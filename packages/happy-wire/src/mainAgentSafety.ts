/**
 * Main agent safety settings (B-922, specs/2026-11-main-agent.md §4.4).
 *
 * The `safety` section of the account KV `vh.main-agent-config.v1`. Shared by
 * the CLI (enforces it), the server (refuses a machine token that loosens it)
 * and the Web (the settings page writes it).
 *
 * Reading is fail-closed: a section this build does not fully understand
 * (wrong `v`, unknown preset, unknown key, invalid value) is read as STRICT,
 * so an older CLI meeting a newer section can only be stricter than intended.
 * A config without any `safety` section reads as the default preset (loose).
 *
 * The same KV value also carries `quietHours` (B-924); it is not a safety
 * setting and never counts as loosening.
 */

export const MAIN_AGENT_SAFETY_CAPABILITY = 'main-agent-safety-v2';
export const MAIN_AGENT_CONFIG_KEY_PREFIX = 'vh.main-agent-config.';
/** Card key prefix of a gate-1 approval card: `main-agent-tool:<approvalId>:<toolName>`. */
export const MAIN_AGENT_TOOL_CARD_KEY_PREFIX = 'main-agent-tool:';
/** Owner choice on that card that grants the tool for good. */
export const MAIN_AGENT_TOOL_ALWAYS_CHOICE = 'always';

export const SAFETY_PRESETS = ['strict', 'standard', 'loose'] as const;
export type SafetyPreset = typeof SAFETY_PRESETS[number];
/** Owner 11-11: the default leans loose; a saved preset always wins. */
export const DEFAULT_SAFETY_PRESET: SafetyPreset = 'loose';

/** What gate 1 does with one class of tool. */
export const TOOL_POLICIES = ['deny', 'ask', 'allow'] as const;
export type ToolPolicy = typeof TOOL_POLICIES[number];
/** What gate 2 does with one risk level. */
export const DISPATCH_POLICIES = ['ask', 'direct'] as const;
export type DispatchPolicy = typeof DISPATCH_POLICIES[number];

export interface MainAgentSafetyPolicy {
    /** Third-party MCP tools that deploy / release / roll back / publish / apply infrastructure. */
    production: ToolPolicy;
    /** Third-party MCP tools that send outside (message, mail, comment, push, share …). */
    outbound: ToolPolicy;
    /** Every other third-party MCP tool that is not clearly read-only. */
    thirdPartyWrite: ToolPolicy;
    /** Gate 2, dispatches re-checked as `external`. */
    dispatchExternal: DispatchPolicy;
    /** Gate 2, dispatches re-checked as `production`. */
    dispatchProduction: DispatchPolicy;
    /** Built-in `Bash`. */
    bash: boolean;
    /** Built-in `Edit` / `Write` / `MultiEdit` / `NotebookEdit`. */
    fileEdits: boolean;
}
export type SafetyPolicyKey = keyof MainAgentSafetyPolicy;
export const SAFETY_POLICY_KEYS: readonly SafetyPolicyKey[] = ['production', 'outbound', 'thirdPartyWrite', 'dispatchExternal', 'dispatchProduction', 'bash', 'fileEdits'];

export const PRESET_POLICIES: Readonly<Record<SafetyPreset, Readonly<MainAgentSafetyPolicy>>> = {
    // B-916c behaviour, unchanged.
    strict: { production: 'deny', outbound: 'deny', thirdPartyWrite: 'deny', dispatchExternal: 'ask', dispatchProduction: 'ask', bash: false, fileEdits: false },
    standard: { production: 'ask', outbound: 'ask', thirdPartyWrite: 'ask', dispatchExternal: 'ask', dispatchProduction: 'ask', bash: false, fileEdits: false },
    loose: { production: 'ask', outbound: 'allow', thirdPartyWrite: 'allow', dispatchExternal: 'direct', dispatchProduction: 'ask', bash: false, fileEdits: false },
};

export interface MainAgentSafety {
    v: 1;
    preset: SafetyPreset;
    /** Per-item overrides on top of the preset (advanced). */
    overrides: Partial<MainAgentSafetyPolicy>;
    /** Exact tool names whose `ask` became `allow` ("always allow this tool"). Never lifts a `deny`. */
    allowedTools: string[];
}

export const ALLOWED_TOOLS_MAX = 64;
const ALLOWED_TOOL_RE = /^[A-Za-z0-9_.-]{1,128}$/;
const DENY_PATTERN_RE = /^[A-Za-z0-9_.*-]{1,128}$/;

export function isValidAllowedTool(value: unknown): value is string {
    return typeof value === 'string' && ALLOWED_TOOL_RE.test(value);
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isPreset = (v: unknown): v is SafetyPreset => typeof v === 'string' && (SAFETY_PRESETS as readonly string[]).includes(v);

function validOverrideValue(key: SafetyPolicyKey, value: unknown): boolean {
    if (key === 'bash' || key === 'fileEdits') return typeof value === 'boolean';
    if (key === 'dispatchExternal' || key === 'dispatchProduction') return typeof value === 'string' && (DISPATCH_POLICIES as readonly string[]).includes(value);
    return typeof value === 'string' && (TOOL_POLICIES as readonly string[]).includes(value);
}

export const STRICT_SAFETY: MainAgentSafety = { v: 1, preset: 'strict', overrides: {}, allowedTools: [] };
export const DEFAULT_SAFETY: MainAgentSafety = { v: 1, preset: DEFAULT_SAFETY_PRESET, overrides: {}, allowedTools: [] };

export interface ParsedSafety {
    safety: MainAgentSafety;
    /** The section was present but not understood → read as strict. */
    failedClosed: boolean;
}

/**
 * `safety` section → settings. `undefined` = no section = default preset.
 * Anything not fully understood = strict (allowedTools ignored too).
 */
export function parseMainAgentSafety(raw: unknown): ParsedSafety {
    if (raw === undefined) return { safety: { ...DEFAULT_SAFETY, overrides: {}, allowedTools: [] }, failedClosed: false };
    const strict = (): ParsedSafety => ({ safety: { ...STRICT_SAFETY, overrides: {}, allowedTools: [] }, failedClosed: true });
    if (!isObj(raw) || raw.v !== 1 || !isPreset(raw.preset)) return strict();
    for (const key of Object.keys(raw)) if (!['v', 'preset', 'overrides', 'allowedTools'].includes(key)) return strict();
    const overrides: Partial<MainAgentSafetyPolicy> = {};
    if (raw.overrides !== undefined) {
        if (!isObj(raw.overrides)) return strict();
        for (const [key, value] of Object.entries(raw.overrides)) {
            if (!(SAFETY_POLICY_KEYS as readonly string[]).includes(key) || !validOverrideValue(key as SafetyPolicyKey, value)) return strict();
            (overrides as Record<string, unknown>)[key] = value;
        }
    }
    const allowedTools: string[] = [];
    if (raw.allowedTools !== undefined) {
        if (!Array.isArray(raw.allowedTools)) return strict();
        const seen = new Set<string>();
        for (const item of raw.allowedTools) {
            if (!isValidAllowedTool(item)) continue; // a bad name is dropped alone; it could only have loosened
            const k = item.toLowerCase();
            if (seen.has(k) || allowedTools.length >= ALLOWED_TOOLS_MAX) continue;
            seen.add(k);
            allowedTools.push(item);
        }
    }
    return { safety: { v: 1, preset: raw.preset, overrides, allowedTools }, failedClosed: false };
}

export function effectiveSafetyPolicy(safety: Pick<MainAgentSafety, 'preset' | 'overrides'>): MainAgentSafetyPolicy {
    return { ...PRESET_POLICIES[safety.preset], ...safety.overrides };
}

const TOOL_RANK: Record<ToolPolicy, number> = { deny: 0, ask: 1, allow: 2 };
const DISPATCH_RANK: Record<DispatchPolicy, number> = { ask: 0, direct: 1 };

function rank(key: SafetyPolicyKey, policy: MainAgentSafetyPolicy): number {
    const value = policy[key];
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (key === 'dispatchExternal' || key === 'dispatchProduction') return DISPATCH_RANK[value as DispatchPolicy];
    return TOOL_RANK[value as ToolPolicy];
}

/** Per item, the stricter of two policies (a local file can only tighten the account setting). */
export function stricterPolicy(a: MainAgentSafetyPolicy, b: MainAgentSafetyPolicy): MainAgentSafetyPolicy {
    const out = { ...a } as Record<SafetyPolicyKey, unknown>;
    for (const key of SAFETY_POLICY_KEYS) if (rank(key, b) < rank(key, a)) out[key] = b[key];
    return out as unknown as MainAgentSafetyPolicy;
}

/** Items of `next` that are looser than `prev`. */
export function loosenedPolicyKeys(prev: MainAgentSafetyPolicy, next: MainAgentSafetyPolicy): SafetyPolicyKey[] {
    return SAFETY_POLICY_KEYS.filter((key) => rank(key, next) > rank(key, prev));
}

function deniedSet(config: unknown): Set<string> {
    const out = new Set<string>();
    if (isObj(config) && Array.isArray(config.deniedTools)) {
        for (const item of config.deniedTools) if (typeof item === 'string' && DENY_PATTERN_RE.test(item)) out.add(item.toLowerCase());
    }
    return out;
}

export interface ConfigLoosening {
    /** Policy items that got looser. */
    policy: SafetyPolicyKey[];
    /** allowedTools entries that are new. */
    addedAllowedTools: string[];
    /** deniedTools patterns that were removed. */
    removedDeniedTools: string[];
}

/**
 * How `next` (a whole `vh.main-agent-config.v1` value; null = deleted) is
 * looser than `prev`. Empty everywhere = same or stricter.
 */
export function mainAgentConfigLoosening(prev: unknown, next: unknown): ConfigLoosening {
    const read = (config: unknown) => parseMainAgentSafety(isObj(config) ? config.safety : undefined).safety;
    const a = read(prev);
    const b = read(next);
    const prevAllowed = new Set(a.allowedTools.map((t) => t.toLowerCase()));
    const prevDenied = deniedSet(prev);
    const nextDenied = deniedSet(next);
    return {
        policy: loosenedPolicyKeys(effectiveSafetyPolicy(a), effectiveSafetyPolicy(b)),
        addedAllowedTools: b.allowedTools.filter((t) => !prevAllowed.has(t.toLowerCase())),
        removedDeniedTools: [...prevDenied].filter((p) => !nextDenied.has(p)),
    };
}

export function isLoosening(l: ConfigLoosening): boolean {
    return l.policy.length > 0 || l.addedAllowedTools.length > 0 || l.removedDeniedTools.length > 0;
}

/**
 * Server check for a machine-token write: a `safety` section it cannot read
 * (unknown version / field / value) counts as loosening — the server does not
 * guess what a newer client meant. A missing section is the default preset.
 */
export function unreadableSafetySection(config: unknown): boolean {
    if (config === null) return false;
    if (!isObj(config)) return true;
    return config.safety !== undefined && parseMainAgentSafety(config.safety).failedClosed;
}

/** B-924 quiet hours on the same config value. Lenient: anything invalid falls back to the default. */
export interface MainAgentQuietHours {
    enabled: boolean;
    /** `HH:MM`, 24h */
    start: string;
    end: string;
    /** IANA zone; null = the main agent machine's local time */
    tz: string | null;
}
export const DEFAULT_QUIET_HOURS: Readonly<MainAgentQuietHours> = { enabled: true, start: '00:30', end: '08:30', tz: null };
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
export function parseMainAgentQuietHours(raw: unknown): MainAgentQuietHours {
    const out: MainAgentQuietHours = { ...DEFAULT_QUIET_HOURS };
    if (!isObj(raw)) return out;
    if (typeof raw.enabled === 'boolean') out.enabled = raw.enabled;
    if (typeof raw.start === 'string' && HHMM_RE.test(raw.start)) out.start = raw.start;
    if (typeof raw.end === 'string' && HHMM_RE.test(raw.end)) out.end = raw.end;
    if (typeof raw.tz === 'string' && raw.tz.length > 0 && raw.tz.length <= 64) out.tz = raw.tz;
    return out;
}

/** `main-agent-tool:<approvalId>:<toolName>` → toolName (null when not such a key). */
export function toolNameFromToolCardKey(key: unknown): string | null {
    if (typeof key !== 'string' || !key.startsWith(MAIN_AGENT_TOOL_CARD_KEY_PREFIX)) return null;
    const rest = key.slice(MAIN_AGENT_TOOL_CARD_KEY_PREFIX.length);
    const sep = rest.indexOf(':');
    if (sep <= 0) return null;
    const tool = rest.slice(sep + 1);
    return isValidAllowedTool(tool) ? tool : null;
}
