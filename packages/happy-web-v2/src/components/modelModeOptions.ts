import type { Metadata } from '@/sync/storageTypes';
import type { SimpleTranslationKey } from '@/text';
import { hackModes } from '@/sync/modeHacks';
import { getCodeAgentDefaults, isPiAgent, supportsClaudeOpus55 } from '@/sync/agentDefaults';
import { getLatestModelTier, type LatestModelTable } from '@slopus/happy-wire';

export type ModeOption = {
    key: string;
    name: string;
    description?: string | null;
    /** Listed but not pickable here (B-849a2: Claude 「本机配置」 mid-session). */
    disabled?: boolean;
};

export type PermissionMode = ModeOption;
export type ModelMode = ModeOption;

export type EffortLevel = ModeOption;
export type PermissionModeKey = string;
export type ModelModeKey = string;

export type AgentFlavor = 'claude' | 'codex' | 'gemini' | string | null | undefined;

type Translate = (key: SimpleTranslationKey) => string;

type MetadataOption = {
    code: string;
    value: string;
    description?: string | null;
};

const GEMINI_MODEL_FALLBACKS: ModelMode[] = [
    { key: 'gemini-3.1-pro-preview', name: 'gemini 3.1 pro', description: 'latest & most capable' },
    { key: 'gemini-3-flash-preview', name: 'gemini 3 flash', description: 'latest & fast' },
    { key: 'gemini-3.1-flash-lite-preview', name: 'gemini 3.1 flash lite', description: 'latest & fastest' },
    { key: 'gemini-2.5-pro', name: 'gemini 2.5 pro', description: 'most capable' },
    { key: 'gemini-2.5-flash', name: 'gemini 2.5 flash', description: 'fast & efficient' },
    { key: 'gemini-2.5-flash-lite', name: 'gemini 2.5 flash lite', description: 'fastest' },
];

export function mapMetadataOptions(options?: MetadataOption[] | null): ModeOption[] {
    if (!options || options.length === 0) {
        return [];
    }

    return options.map((option) => ({
        key: option.code,
        name: option.value,
        description: option.description ?? null,
    }));
}

export function compactResolvedModelCode(modelCode: string): string {
    return modelCode.replace(/^claude-/, '');
}

export function relabelDefaultModel(options: ModelMode[], label: string): ModelMode[] {
    return options.map((option) => option.key === 'default'
        ? { ...option, name: label }
        : option);
}

export function getClaudePermissionModes(translate: Translate): PermissionMode[] {
    return [
        { key: 'default', name: translate('agentInput.permissionMode.default'), description: null },
        { key: 'plan', name: translate('agentInput.permissionMode.plan'), description: null },
        // `dontAsk` deliberately absent (B-262): no released CLI accepts it —
        // its MessageMetaSchema enum rejects the whole message silently.
        { key: 'acceptEdits', name: translate('agentInput.permissionMode.acceptEdits'), description: null },
        { key: 'bypassPermissions', name: translate('agentInput.permissionMode.bypassPermissions'), description: translate('agentInput.permissionMode.autoRunDescription') },
    ];
}

export function getCodexPermissionModes(translate: Translate): PermissionMode[] {
    return [
        { key: 'default', name: translate('agentInput.codexPermissionMode.default'), description: null },
        { key: 'read-only', name: translate('agentInput.codexPermissionMode.readOnly'), description: null },
        { key: 'safe-yolo', name: translate('agentInput.codexPermissionMode.safeYolo'), description: translate('agentInput.permissionMode.sandboxDescription') },
        { key: 'yolo', name: translate('agentInput.codexPermissionMode.yolo'), description: translate('agentInput.permissionMode.fullAccessDescription') },
    ];
}

export function getGeminiPermissionModes(translate: Translate): PermissionMode[] {
    return [
        { key: 'default', name: translate('agentInput.geminiPermissionMode.default'), description: null },
        { key: 'auto_edit', name: translate('agentInput.geminiPermissionMode.autoEdit'), description: null },
        { key: 'yolo', name: translate('agentInput.geminiPermissionMode.yolo'), description: translate('agentInput.permissionMode.autoRunDescription') },
        { key: 'plan', name: translate('agentInput.geminiPermissionMode.plan'), description: null },
    ];
}

/**
 * Claude model picker. Most keys are Claude Code `--model` aliases — the CLI,
 * not this list, decides what they resolve to, so their labels mirror the
 * wrapper's bundled Claude Code (SDK 0.3.318 / CC 2.1.318 without machine
 * overrides: opus → Opus 5.5, sonnet → Sonnet 5.5, haiku → Haiku 5.5; probed
 * 2026-11-06). Opus 5.5 and Fable 5.1 are also offered as pinned ids so they
 * stay put whatever the aliases point at — CC 2.1.318's own catalog lists
 * Fable only as `claude-fable-5-1[1m]` (B-893). Opus 5.5 is the code default
 * (agentDefaults.ts). `[1m]` is Claude Code's 1M-context marker (accepted by
 * the daemon resume path since B-290). `fable5` (pinned Fable 5) is
 * deliberately absent: 2.1.258 rejects it with `unrecognized_model` (probed
 * 2026-09-03).
 */
export function getClaudeModelModes(): ModelMode[] {
    return [
        { key: 'default', name: 'default model', description: null },
        ...CLAUDE_PINNED_MODELS,
        { key: 'claude-fable-5-1', name: 'Fable 5.1', description: null },
        { key: 'claude-fable-5-1[1m]', name: 'Fable 5.1 · 1M', description: null },
        { key: 'fable', name: 'fable (alias)', description: null },
        { key: 'fable[1m]', name: 'fable (alias) · 1M', description: null },
        { key: 'best', name: 'best', description: null },
        { key: 'opus', name: 'opus (alias)', description: null },
        { key: 'opus[1m]', name: 'opus (alias) · 1M', description: null },
        { key: 'sonnet', name: 'Sonnet 5.5', description: null },
        { key: 'sonnet[1m]', name: 'Sonnet 5.5 · 1M', description: null },
        { key: 'haiku', name: 'Haiku 5.5', description: null },
        { key: 'opusplan', name: 'opusplan', description: null },
    ];
}

const CLAUDE_PINNED_MODELS: ModelMode[] = [
    { key: 'claude-opus-5-5', name: 'Opus 5.5', description: null },
    { key: 'claude-opus-5-5[1m]', name: 'Opus 5.5 · 1M', description: null },
];

const LONG_CONTEXT = '[1m]';

/** `claude-fable-5-1` → 「Fable 5.1」; anything else null. */
function claudeIdName(id: string): string | null {
    const match = /^claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2}))?$/.exec(id);
    if (!match) return null;
    return `${match[1][0].toUpperCase()}${match[1].slice(1)} ${match[2]}${match[3] ? `.${match[3]}` : ''}`;
}

/**
 * B-893: Claude Code 2.1.30x+ lists Fable only as `claude-fable-5-1[1m]`
 * (display name 「Fable」). With no plain entry the picker could not make it
 * its family's newest (1M twins ride on a base entry), so it sank into
 * 「更多模型」. Add the plain id before such a twin, and name both by version.
 */
export function withClaudeCatalogBases(models: ModelMode[]): ModelMode[] {
    const keys = new Set(models.map((model) => model.key));
    const out: ModelMode[] = [];
    for (const model of models) {
        const base = model.key.endsWith(LONG_CONTEXT) ? model.key.slice(0, -LONG_CONTEXT.length) : null;
        const name = base ? claudeIdName(base) : null;
        if (base && name && !keys.has(base)) {
            out.push({ key: base, name, description: model.description ?? null });
            keys.add(base);
        }
        out.push(base && name ? { ...model, name: `${name} · 1M` } : model);
    }
    return out;
}

/**
 * Keys the wrapper's catalog proves it runs, for 「newest of the family」:
 * the codes, the plain id of a `[1m]`-only entry, Claude's pinned Opus 5.5
 * (listed only as the `opus` alias) and — Codex — the gpt-6 generation, which
 * every Codex on llm-hub runs whether or not it bundles the entry (B-893).
 */
export function catalogRunnableKeys(flavor: AgentFlavor, codes: readonly string[], opts: { claudeOpus55?: boolean } = {}): Set<string> {
    const out = new Set(codes);
    for (const code of codes) if (code.endsWith(LONG_CONTEXT)) out.add(code.slice(0, -LONG_CONTEXT.length));
    if (flavor === 'codex') for (const { key } of CODEX_KNOWN_MODELS) out.add(key);
    if (flavor === 'claude' && opts.claudeOpus55 !== false) out.add('claude-opus-5-5');
    return out;
}

/**
 * B-893: the gpt-6 generation, newest first, with the first Codex whose
 * bundled `model/list` carries each (`codex debug models`, bisected over
 * 0.154–0.167 on 2026-11-06). An older Codex still runs them — 0.154 ran all
 * five end to end through `codex exec -m` on llm-hub — it only lacks their
 * catalog entry (effort levels, context window), so the picker lists them
 * everywhere and marks the gap (codexModelGate) instead of hiding them.
 */
export const CODEX_KNOWN_MODELS: ReadonlyArray<{ key: string; since?: string }> = [
    { key: 'gpt-6.1-sol', since: '0.160.0' },
    { key: 'gpt-6.1-terra', since: '0.165.0' },
    { key: 'gpt-6-astra' },
    { key: 'gpt-6-sol', since: '0.157.0' },
    { key: 'gpt-6-luna', since: '0.157.0' },
];

const CODEX_EXTRA_MODELS: ModelMode[] = CODEX_KNOWN_MODELS.map(({ key }) => ({ key, name: key, description: null }));

/**
 * The Codex version a known model needs in its bundled catalog, when this
 * machine's Codex lacks it: not in the session's catalog and the installed
 * version (if known) is older. Null = nothing to mark.
 */
export function codexModelGate(
    key: string,
    input: { catalogCodes?: ReadonlySet<string> | null; agentVersion?: string | null },
): { since: string } | null {
    const since = CODEX_KNOWN_MODELS.find((model) => model.key === key)?.since;
    if (!since || input.catalogCodes?.has(key)) return null;
    // Installed version decides; unknown version → a catalog without it does.
    const below = input.agentVersion ? versionBelow(input.agentVersion, since) : null;
    if (below === false || (below === null && !input.catalogCodes?.size)) return null;
    return { since };
}

function versionBelow(a: string, b: string): boolean | null {
    const parse = (value: string) => {
        const parts = value.trim().replace(/^v/, '').split(/[-+]/)[0].split('.').map(Number);
        return parts.every((part) => Number.isInteger(part) && part >= 0) ? parts : null;
    };
    const left = parse(a);
    const right = parse(b);
    if (!left || !right) return null;
    for (let i = 0; i < Math.max(left.length, right.length); i++) {
        const diff = (left[i] ?? 0) - (right[i] ?? 0);
        if (diff !== 0) return diff < 0;
    }
    return false;
}

export function getCodexModelModes(): ModelMode[] {
    return [
        { key: 'default', name: 'default model', description: null },
        ...CODEX_EXTRA_MODELS,
        { key: 'gpt-5.6-sol', name: 'gpt-5.6-sol', description: null },
        { key: 'gpt-5.6-terra', name: 'gpt-5.6-terra', description: null },
        { key: 'gpt-5.6-luna', name: 'gpt-5.6-luna', description: null },
        { key: 'gpt-5.5', name: 'gpt-5.5', description: null },
        { key: 'gpt-5.4', name: 'gpt-5.4', description: null },
        { key: 'gpt-5.3-codex', name: 'gpt-5.3-codex', description: null },
        { key: 'gpt-5.2-codex', name: 'gpt-5.2-codex', description: null },
        { key: 'gpt-5.1-codex-max', name: 'gpt-5.1-codex-max', description: null },
        { key: 'gpt-5.2', name: 'gpt-5.2', description: null },
        { key: 'gpt-5.1-codex-mini', name: 'gpt-5.1-codex-mini', description: null },
    ];
}

/**
 * Models the wrapper's published catalog can lack but the session can still
 * run: pinned Opus 5.5 (the SDK lists it only under its `opus` alias, and only
 * on wrappers that advertise the capability) and Codex models newer than
 * Codex's bundled list.
 */
function getCatalogExtras(flavor: AgentFlavor, metadata: Metadata | null | undefined): ModelMode[] {
    if (flavor === 'codex') return CODEX_EXTRA_MODELS;
    if (flavor === 'claude' && supportsClaudeOpus55(metadata)) return CLAUDE_PINNED_MODELS;
    return [];
}

/**
 * With pinned Opus 5.5 in the menu, the SDK's own `opus` alias entry (display
 * name "Opus 5.5", resolvedModel claude-opus-5-5) reads as a duplicate. Keep
 * the entry — a session may have it selected — but name it for what it is.
 */
function labelPinnedAliases(flavor: AgentFlavor, metadata: Metadata | null | undefined, models: ModelMode[]): ModelMode[] {
    if (flavor !== 'claude' || !supportsClaudeOpus55(metadata)) return models;
    const pinnedKeys = new Set(CLAUDE_PINNED_MODELS.map((model) => model.key));
    const aliasOfPinned = new Set((metadata?.models ?? [])
        .filter((model) => model.code !== 'default' && !pinnedKeys.has(model.code)
            && typeof model.resolvedModel === 'string' && model.resolvedModel.replace(/\[1m\]$/, '') === 'claude-opus-5-5')
        .map((model) => model.code));
    return models.map((model) => aliasOfPinned.has(model.key)
        ? { ...model, name: `${model.key.replace(/\[1m\]$/, '')} (alias${model.key.endsWith('[1m]') ? ', 1M context' : ''})` }
        : model);
}

export function getGeminiModelModes(): ModelMode[] {
    return GEMINI_MODEL_FALLBACKS;
}

export function getOpenClawPermissionModes(translate: Translate): PermissionMode[] {
    return [
        { key: 'default', name: translate('agentInput.permissionMode.default'), description: null },
        { key: 'bypassPermissions', name: translate('agentInput.permissionMode.bypassPermissions'), description: translate('agentInput.permissionMode.autoRunDescription') },
    ];
}

/**
 * pi permission picker (B-370). The pi runner keeps Claude's vocabulary
 * (B-350), but the pi-side gate only distinguishes two behaviours: `default`
 * (ask → permission card) and `bypassPermissions` (auto-allow every ask rule);
 * `plan`/`acceptEdits` are treated as `default` there, so offering them would
 * promise a plan mode / auto-accepted edits that do not exist.
 */
export function getPiPermissionModes(translate: Translate): PermissionMode[] {
    return [
        { key: 'default', name: translate('agentInput.permissionMode.default'), description: null },
        { key: 'bypassPermissions', name: translate('agentInput.permissionMode.bypassPermissions'), description: translate('agentInput.permissionMode.autoRunDescription') },
    ];
}

export function getHardcodedPermissionModes(flavor: AgentFlavor, translate: Translate): PermissionMode[] {
    if (flavor === 'codex') {
        return getCodexPermissionModes(translate);
    }
    if (flavor === 'gemini') {
        return getGeminiPermissionModes(translate);
    }
    if (flavor === 'openclaw') {
        return getOpenClawPermissionModes(translate);
    }
    if (isPiAgent(flavor)) {
        return getPiPermissionModes(translate);
    }
    return getClaudePermissionModes(translate);
}

export function getOpenClawModelModes(): ModelMode[] {
    return [
        { key: 'default', name: 'default model', description: null },
    ];
}

/**
 * pi has no hardcodable model list: its registry is whatever providers the
 * machine's pi is configured with (pi-acp publishes it per session in
 * `metadata.models`, e.g. `llm-hub/claude-fable-5-1`). Without a session the
 * only honest option is `default` = don't send a model. Settings → Agents
 * widens this with the models pi sessions on the account have published
 * (sync/piModelOptions.ts).
 */
export function getPiModelModes(): ModelMode[] {
    return [
        { key: 'default', name: 'default model', description: null },
    ];
}

/**
 * Models the latest-models table knows (B-844) that a code list lacks — a
 * flagship the server table added after this bundle shipped stays pickable.
 * Inserted after the leading `default` entry.
 */
export function withLatestTableModels(flavor: AgentFlavor, models: ModelMode[], table: LatestModelTable | null | undefined): ModelMode[] {
    const tier = getLatestModelTier(table, typeof flavor === 'string' ? flavor : 'claude');
    if (!tier || isPiAgent(flavor)) return models;
    const missing = tier.models
        .filter((entry) => !models.some((model) => model.key === entry.model))
        .map((entry) => ({ key: entry.model, name: entry.label ?? entry.model, description: null }));
    if (missing.length === 0) return models;
    const [first, ...rest] = models;
    return first?.key === 'default' ? [first, ...missing, ...rest] : [...missing, ...models];
}

/**
 * Picker list when there is no session (new-session dialog, settings —
 * B-844): the live catalogs recent sessions of this agent published (newest
 * first; per machine in the dialog, account-wide in settings) merged with the
 * code list and the latest-models table, so a CLI/Codex upgrade shows up
 * without a web release. Each catalog is decorated exactly like a session's.
 */
export function getLauncherModelModes(
    flavor: AgentFlavor,
    catalogs: ReadonlyArray<Metadata | null | undefined>,
    translate: Translate,
    table?: LatestModelTable | null,
): ModelMode[] {
    const out: ModelMode[] = [];
    const seen = new Set<string>();
    const add = (models: ModelMode[]) => {
        for (const model of models) {
            if (seen.has(model.key)) continue;
            seen.add(model.key);
            out.push(model);
        }
    };
    for (const metadata of catalogs) {
        if (metadata?.models?.length) add(getAvailableModels(flavor, metadata, translate));
    }
    add(getHardcodedModelModes(flavor, translate, table));
    const defaultIndex = out.findIndex((model) => model.key === 'default');
    if (defaultIndex > 0) out.unshift(...out.splice(defaultIndex, 1));
    return out;
}

export function getHardcodedModelModes(flavor: AgentFlavor, _translate: Translate, table?: LatestModelTable | null): ModelMode[] {
    if (flavor === 'codex') {
        return withLatestTableModels(flavor, getCodexModelModes(), table);
    }
    if (flavor === 'gemini') {
        return withLatestTableModels(flavor, getGeminiModelModes(), table);
    }
    if (flavor === 'openclaw') {
        return getOpenClawModelModes();
    }
    if (isPiAgent(flavor)) {
        return getPiModelModes();
    }
    return withLatestTableModels('claude', getClaudeModelModes(), table);
}

export function getAvailableModels(
    flavor: AgentFlavor,
    metadata: Metadata | null | undefined,
    translate: Translate,
): ModelMode[] {
    const mapped = mapMetadataOptions(metadata?.models);
    const metadataModels = labelPinnedAliases(flavor, metadata, flavor === 'claude' ? withClaudeCatalogBases(mapped) : mapped);
    if (metadataModels.length > 0) {
        const extras = getCatalogExtras(flavor, metadata).filter((extra) => !metadataModels.some((model) => model.key === extra.key));
        const [first, ...rest] = metadataModels;
        const withExtras = first?.key === 'default' ? [first, ...extras, ...rest] : [...extras, ...metadataModels];
        if ((flavor === 'codex' || flavor === 'claude') && !withExtras.some((model) => model.key === 'default')) {
            return [{ key: 'default', name: 'default model', description: null }, ...withExtras];
        }
        return withExtras;
    }
    return getHardcodedModelModes(flavor, translate);
}

export function getAvailablePermissionModes(
    flavor: AgentFlavor,
    metadata: Metadata | null | undefined,
    translate: Translate,
): PermissionMode[] {
    if (flavor === 'claude' || flavor === 'codex' || flavor === 'openclaw') {
        return hackModes(getHardcodedPermissionModes(flavor, translate));
    }
    // pi: `metadata.operatingModes` is pi-acp's legacy `modes` field, which
    // carries the THINKING level ("Thinking: off/minimal/…/xhigh"; probed on 23
    // sessions 2026-09-07), not a permission mode. Its permission layer is the
    // pi-side gate (B-350) with the fixed vocabulary above.
    if (isPiAgent(flavor)) {
        return hackModes(getHardcodedPermissionModes(flavor, translate));
    }

    const metadataModes = mapMetadataOptions(metadata?.operatingModes);
    if (metadataModes.length > 0) {
        const labels = flavor === 'gemini' ? getGeminiPermissionModes(translate) : [];
        return hackModes(metadataModes.map((option) => {
            const known = labels.find((label) => label.key === option.key);
            return known ? { ...option, name: known.name, description: known.description ?? option.description } : option;
        }));
    }

    return hackModes(getHardcodedPermissionModes(flavor, translate));
}

export function findOptionByKey<T extends ModeOption>(options: T[], key: string | null | undefined): T | null {
    if (!key) {
        return null;
    }
    return options.find((option) => option.key === key) ?? null;
}

export function resolveCurrentOption<T extends ModeOption>(
    options: T[],
    preferredKeys: Array<string | null | undefined>,
): T | null {
    for (const key of preferredKeys) {
        const option = findOptionByKey(options, key);
        if (option) {
            return option;
        }
    }
    return null;
}

export function getDefaultModelKey(flavor: AgentFlavor): string {
    return getCodeAgentDefaults(flavor).modelMode;
}

export function getDefaultPermissionModeKey(flavor: AgentFlavor): string {
    return getCodeAgentDefaults(flavor).permissionMode;
}

// Effort levels per agent type

export function getClaudeEffortLevels(): EffortLevel[] {
    return [
        { key: 'low', name: 'low' },
        { key: 'medium', name: 'medium' },
        { key: 'high', name: 'high' },
        { key: 'xhigh', name: 'xhigh' },
        { key: 'max', name: 'max' },
    ];
}

export function getCodexEffortLevels(): EffortLevel[] {
    return [
        { key: 'low', name: 'low' },
        { key: 'medium', name: 'medium' },
        { key: 'high', name: 'high' },
        { key: 'xhigh', name: 'xhigh' },
    ];
}

export function getHardcodedEffortLevels(flavor: AgentFlavor): EffortLevel[] {
    if (flavor === 'claude') return getClaudeEffortLevels();
    if (flavor === 'codex') return getCodexEffortLevels();
    return [];
}

export function getDefaultEffortKey(flavor: AgentFlavor): string | null {
    return getCodeAgentDefaults(flavor).effortLevel;
}

// Per-model effort: returns effort levels for a specific model, or empty if the model has no effort
export function getEffortLevelsForModel(
    flavor: AgentFlavor, modelKey: string, metadata?: Metadata | null,
): EffortLevel[] {
    if (flavor === 'codex' || flavor === 'claude') {
        const resolvedKey = modelKey === 'default' ? metadata?.defaultModelCode ?? 'default' : modelKey;
        const model = metadata?.models?.find((option) => option.code === resolvedKey || option.resolvedModel === resolvedKey);
        if (model?.reasoningEfforts) {
            return model.reasoningEfforts.map((key) => ({ key, name: key }));
        }
        if (flavor === 'claude') {
            return /haiku/i.test(resolvedKey ?? modelKey) ? [] : getClaudeEffortLevels();
        }
        const levels = getCodexEffortLevels();
        // Old wrappers silently ignore newer levels. Only advertise expanded
        // session ranges when that wrapper published its model capabilities.
        if (metadata && !metadata.models?.length) return levels;
        // Codex 0.153.4 app-server fallback, verified via model/list; gpt-6-sol
        // and gpt-6-luna follow their 5.6 siblings (luna tops out at max).
        // A connected machine's advertised catalog always takes precedence.
        const key = resolvedKey ?? modelKey;
        if (/^gpt-(6(\.\d+)?-(astra|sol|terra|luna)|5\.6-(sol|terra|luna))$/.test(key)) {
            const higher = [...levels, { key: 'max', name: 'max' }];
            return key.endsWith('-luna') ? higher : [...higher, { key: 'ultra', name: 'ultra' }];
        }
        return levels;
    }
    // ACP advertises the current model's selector, not a per-model catalog.
    // Hide it while a different model is only a local selection.
    if (modelKey !== 'default' && metadata?.currentModelCode && modelKey !== metadata.currentModelCode) return [];
    if (metadata?.thoughtLevels) return mapMetadataOptions(metadata.thoughtLevels);
    if (isPiAgent(flavor)) return mapMetadataOptions(metadata?.operatingModes);
    if (flavor === 'claude') return getClaudeEffortLevels();
    return [];
}

// Default effort for a model — highest the model allows
export function getDefaultEffortKeyForModel(flavor: AgentFlavor, modelKey: string): string | null {
    const levels = getEffortLevelsForModel(flavor, modelKey);
    if (levels.length === 0) return null;
    return getCodeAgentDefaults(flavor).effortLevel ?? levels[levels.length - 1].key;
}

export function getSupportsWorktree(flavor: AgentFlavor): boolean {
    if (flavor === 'openclaw') return false;
    return true;
}
