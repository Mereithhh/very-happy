/**
 * B-920 `very-happy settings` key policy: which keys each scope may write, the
 * value shape (wire schemas shared with the Web), and whether a change needs
 * the owner's decision first.
 *
 *  - Open keys: written directly.
 *  - High-risk keys (loosening permissions or the sandbox, server / credential
 *    settings, anything that runs a command by itself): a decision card on the
 *    calling session's board first; written only with `--approved <cardId>`
 *    after the owner approved that exact {scope, key, value}. Tightening the
 *    same key is written directly.
 *  - Everything else is refused. `todoProvider`, `webPanels`, `machineId` and
 *    credential files are never reachable through this command.
 */

import {
    AccountSettingsSchema, AgentDefaultOverrideSchema, AGENT_KEYS, MachineSettingsWritableSchema, ProjectDefaultsSchema,
    type MachineSandboxConfig,
} from '@slopus/happy-wire';
import { z } from 'zod';

export const SETTINGS_SCOPES = ['account', 'machine', 'project'] as const;
export type SettingsScope = typeof SETTINGS_SCOPES[number];

export type Risk = 'open' | 'owner';

export type KeySpec = {
    scope: SettingsScope;
    /** Dotted path inside the scope's object (`agentDefaultOverrides.claude.modelMode`, `defaults.model`). */
    key: string;
    schema: z.ZodTypeAny;
    /** Classify one change; `current` is the stored value (undefined = unset). */
    risk: (current: unknown, next: unknown) => Risk;
    /** One line for `settings list`. */
    describe: string;
};

/** Keys no form of this command reaches, in any scope (B-007 / B-510 RCE guard, identity, credentials). */
export const NEVER_WRITABLE = ['todoProvider', 'webPanels', 'machineId', 'machineIdConfirmedByServer', 'access.key', 'agent.key', 'credentials', 'secret', 'token'] as const;

const open = (): Risk => 'open';
const owner = (): Risk => 'owner';

// ── permission modes ────────────────────────────────────────────────────────
export const PERMISSION_MODES = ['default', 'plan', 'read-only', 'acceptEdits', 'safe-yolo', 'bypassPermissions', 'yolo'] as const;
const PERMISSION_RANK: Record<string, number> = {
    plan: 0, 'read-only': 0, default: 0,
    acceptEdits: 1, 'safe-yolo': 1,
    bypassPermissions: 2, yolo: 2,
};
/** An unset mode is the agent's own default: it reads as `default`. */
export function permissionLoosens(current: unknown, next: unknown): boolean {
    const from = PERMISSION_RANK[typeof current === 'string' ? current : 'default'] ?? 0;
    const to = PERMISSION_RANK[typeof next === 'string' ? next : 'default'] ?? 2;
    return to > from;
}
const permissionRisk = (current: unknown, next: unknown): Risk => permissionLoosens(current, next) ? 'owner' : 'open';
const permissionModeSchema = z.enum(PERMISSION_MODES).nullable();

// ── sandbox ─────────────────────────────────────────────────────────────────
const NETWORK_RANK = { blocked: 0, custom: 1, allowed: 2 } as const;
const ISOLATION_RANK = { strict: 0, workspace: 1, custom: 2 } as const;
const added = (from: string[] | undefined, to: string[] | undefined) => (to ?? []).some((value) => !(from ?? []).includes(value));
const removed = (from: string[] | undefined, to: string[] | undefined) => added(to, from);

/** True when `next` allows anything `current` did not (disabling it, wider paths or network). */
export function sandboxLoosens(current: unknown, next: MachineSandboxConfig): boolean {
    const cur = (current && typeof current === 'object' ? current : {}) as Partial<MachineSandboxConfig>;
    if (!cur.enabled) return false; // no sandbox today: any config is at least as strict
    if (!next.enabled) return true;
    if ((next.workspaceRoot ?? null) !== (cur.workspaceRoot ?? null)) return true;
    if (NETWORK_RANK[next.networkMode ?? 'allowed'] > NETWORK_RANK[cur.networkMode ?? 'allowed']) return true;
    if (ISOLATION_RANK[next.sessionIsolation ?? 'workspace'] > ISOLATION_RANK[cur.sessionIsolation ?? 'workspace']) return true;
    if ((next.allowLocalBinding ?? true) && !(cur.allowLocalBinding ?? true)) return true;
    return added(cur.customWritePaths, next.customWritePaths)
        || added(cur.extraWritePaths, next.extraWritePaths)
        || added(cur.allowedDomains, next.allowedDomains)
        || removed(cur.denyReadPaths, next.denyReadPaths)
        || removed(cur.denyWritePaths, next.denyWritePaths)
        || removed(cur.deniedDomains, next.deniedDomains);
}

// ── account ─────────────────────────────────────────────────────────────────
const accountShape = AccountSettingsSchema.shape;
const ACCOUNT_OPEN_KEYS = [
    // display and preferences
    'viewInline', 'expandTodos', 'showLineNumbers', 'showLineNumbersInToolViews', 'wrapLinesInDiffs', 'diffStyle',
    'alwaysShowContextSize', 'agentInputEnterToSend', 'avatarStyle', 'showFlavorIcons', 'hideInactiveSessions',
    'fileDiffsSidebar', 'groupToolCalls', 'sidebarSort', 'preferredLanguage', 'analyticsOptOut', 'experiments',
    // voice preferences
    'voiceAssistantLanguage', 'voiceTtsVoiceId', 'voiceReadTextReplies', 'voicePttSound',
    // new-session defaults
    'newSessionAgent', 'newSessionAlwaysAsk', 'claudeLongContextOptOut',
] as const satisfies ReadonlyArray<keyof typeof accountShape>;

/** Does a prompt preset list add or change a preset that runs on select (`run: true`)? */
function presetsAddRunnable(current: unknown, next: unknown): boolean {
    const before = new Map((Array.isArray(current) ? current : []).map((p: any) => [p?.id, p]));
    return (Array.isArray(next) ? next : []).some((preset: any) => {
        if (preset?.run !== true) return false;
        const old = before.get(preset.id) as any;
        return !old || old.run !== true || old.text !== preset.text;
    });
}

const accountSpecs: KeySpec[] = [
    ...ACCOUNT_OPEN_KEYS.map((key): KeySpec => ({ scope: 'account', key, schema: accountShape[key], risk: open, describe: accountShape[key].description ?? key })),
    ...AGENT_KEYS.flatMap((agent): KeySpec[] => [
        { scope: 'account', key: `agentDefaultOverrides.${agent}.modelMode`, schema: AgentDefaultOverrideSchema.shape.modelMode.unwrap().max(256).nullable(), risk: open, describe: `New ${agent} sessions: model` },
        { scope: 'account', key: `agentDefaultOverrides.${agent}.effortLevel`, schema: AgentDefaultOverrideSchema.shape.effortLevel.unwrap().max(64).nullable(), risk: open, describe: `New ${agent} sessions: effort` },
        { scope: 'account', key: `agentDefaultOverrides.${agent}.permissionMode`, schema: permissionModeSchema, risk: permissionRisk, describe: `New ${agent} sessions: permission mode (loosening needs the owner)` },
    ]),
    { scope: 'account', key: 'assistantSkipPermissions', schema: accountShape.assistantSkipPermissions, risk: (_c, next) => next === true ? 'owner' : 'open', describe: 'Main agent skips approvals (turning it on needs the owner)' },
    { scope: 'account', key: 'inferenceOpenAIKey', schema: accountShape.inferenceOpenAIKey, risk: owner, describe: 'API key for inference (needs the owner)' },
    { scope: 'account', key: 'voiceBypassToken', schema: accountShape.voiceBypassToken, risk: (_c, next) => next === true ? 'owner' : 'open', describe: 'Voice connects directly with a custom agent (turning it on needs the owner)' },
    { scope: 'account', key: 'terminalStartupCommand', schema: accountShape.terminalStartupCommand.max(1_000), risk: (_c, next) => next === '' ? 'open' : 'owner', describe: 'Command run in every new Web terminal (needs the owner; empty = off)' },
    { scope: 'account', key: 'terminalStartupPresets', schema: accountShape.terminalStartupPresets.max(50), risk: (_c, next) => Array.isArray(next) && next.length === 0 ? 'open' : 'owner', describe: 'Startup commands offered for new Web terminals (needs the owner)' },
    { scope: 'account', key: 'promptPresets', schema: accountShape.promptPresets.max(200), risk: (c, next) => presetsAddRunnable(c, next) ? 'owner' : 'open', describe: 'Shortcuts; adding or changing one with run=true needs the owner' },
];

// ── machine ─────────────────────────────────────────────────────────────────
const machineShape = MachineSettingsWritableSchema.shape;
const unwrap = (schema: z.ZodTypeAny): z.ZodTypeAny => schema instanceof z.ZodOptional ? schema.unwrap() as z.ZodTypeAny : schema;
const machineSpecs: KeySpec[] = [
    { scope: 'machine', key: 'agentHibernationIdleMs', schema: unwrap(machineShape.agentHibernationIdleMs), risk: open, describe: 'Idle agent hibernation threshold in ms (0 = off, 1h–24h)' },
    { scope: 'machine', key: 'autoRestartSessions', schema: unwrap(machineShape.autoRestartSessions), risk: open, describe: 'Restart idle sessions left on old code after a CLI update' },
    { scope: 'machine', key: 'agentAutoUpdate', schema: unwrap(machineShape.agentAutoUpdate), risk: open, describe: 'Update agent CLIs (Codex) automatically' },
    { scope: 'machine', key: 'cliAutoUpdate', schema: unwrap(machineShape.cliAutoUpdate), risk: open, describe: 'Install the recommended Very Happy CLI while idle (idle | off)' },
    { scope: 'machine', key: 'terminalAutoRestore', schema: unwrap(machineShape.terminalAutoRestore), risk: open, describe: 'Bring Web terminals back after a restart' },
    { scope: 'machine', key: 'terminalAutoRestoreMax', schema: unwrap(machineShape.terminalAutoRestoreMax), risk: open, describe: 'At most this many terminals restored (0–20)' },
    { scope: 'machine', key: 'terminalAutoRestoreWindowHours', schema: unwrap(machineShape.terminalAutoRestoreWindowHours), risk: open, describe: 'Only terminals seen alive within this many hours' },
    { scope: 'machine', key: 'claudeCredentialStore', schema: unwrap(machineShape.claudeCredentialStore), risk: owner, describe: 'Claude credential store for spawned sessions (needs the owner)' },
    { scope: 'machine', key: 'serverUrl', schema: unwrap(machineShape.serverUrl), risk: owner, describe: 'Server this machine connects to (needs the owner)' },
    { scope: 'machine', key: 'webappUrl', schema: unwrap(machineShape.webappUrl), risk: owner, describe: 'Web app URL for links (needs the owner)' },
    { scope: 'machine', key: 'sandboxConfig', schema: unwrap(machineShape.sandboxConfig), risk: (c, next) => sandboxLoosens(c, next as MachineSandboxConfig) ? 'owner' : 'open', describe: 'OS sandbox; disabling or widening it needs the owner' },
];

// ── project ─────────────────────────────────────────────────────────────────
const projectShape = ProjectDefaultsSchema.shape;
const projectSpecs: KeySpec[] = [
    { scope: 'project', key: 'defaults.agent', schema: z.enum(AGENT_KEYS).nullable(), risk: open, describe: 'Agent for new sessions in this project' },
    { scope: 'project', key: 'defaults.model', schema: unwrap(projectShape.model), risk: open, describe: 'Model for new sessions in this project (null = agent default)' },
    { scope: 'project', key: 'defaults.worktree', schema: unwrap(projectShape.worktree), risk: open, describe: 'New sessions start in a fresh worktree' },
    { scope: 'project', key: 'defaults.permissionMode', schema: permissionModeSchema, risk: permissionRisk, describe: 'Permission mode for new sessions (loosening needs the owner)' },
];

export const KEY_SPECS: readonly KeySpec[] = [...accountSpecs, ...machineSpecs, ...projectSpecs];

export function specFor(scope: SettingsScope, key: string): KeySpec | null {
    return KEY_SPECS.find((spec) => spec.scope === scope && spec.key === key) ?? null;
}

export function isNeverWritable(key: string): boolean {
    const head = key.split('.')[0]!.trim().toLowerCase();
    return NEVER_WRITABLE.some((name) => name.toLowerCase() === head);
}

/** Scope a bare key belongs to when `--scope` is not given (unique across scopes; `defaults.*` is project). */
export function defaultScopeFor(key: string): SettingsScope | null {
    const scopes = [...new Set(KEY_SPECS.filter((spec) => spec.key === key).map((spec) => spec.scope))];
    return scopes.length === 1 ? scopes[0]! : null;
}

export type ValidationResult =
    | { ok: true; spec: KeySpec; value: unknown }
    | { ok: false; error: 'key_never_writable' | 'unknown_key' | 'invalid_value'; detail?: string };

/** Whitelist + schema: the only way a value reaches a writer. */
export function validateSetting(scope: SettingsScope, key: string, value: unknown): ValidationResult {
    if (isNeverWritable(key)) return { ok: false, error: 'key_never_writable' };
    const spec = specFor(scope, key);
    if (!spec) return { ok: false, error: 'unknown_key' };
    const parsed = spec.schema.safeParse(value);
    if (!parsed.success) return { ok: false, error: 'invalid_value', detail: parsed.error.issues.map((issue) => `${issue.path.join('.') || 'value'}: ${issue.message}`).join('; ').slice(0, 300) };
    return { ok: true, spec, value: parsed.data };
}

// ── dotted paths ────────────────────────────────────────────────────────────
export function getPath(object: unknown, path: string): unknown {
    let cursor: any = object;
    for (const part of path.split('.')) {
        if (!cursor || typeof cursor !== 'object') return undefined;
        cursor = cursor[part];
    }
    return cursor;
}

/** Copy-on-write set; intermediate objects are created, everything else kept. */
export function setPath<T extends Record<string, unknown>>(object: T, path: string, value: unknown): T {
    const [head, ...rest] = path.split('.');
    if (!head) return object;
    if (rest.length === 0) return { ...object, [head]: value };
    const child = object[head];
    return { ...object, [head]: setPath(child && typeof child === 'object' && !Array.isArray(child) ? child as Record<string, unknown> : {}, rest.join('.'), value) };
}
