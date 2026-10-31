import { LATEST_MODEL_MODE } from '@slopus/happy-wire';
import type { ModeOption } from '@/components/modelModeOptions';
import type { SimpleTranslationKey, t as translateFn } from '@/text';
import { normalizeAgentKey } from '@/sync/agentDefaults';
import { LONG_CONTEXT_SUFFIX, modelFamilyOf } from './modelPickerLayout';

type Translate = typeof translateFn;

/**
 * B-849a: one vocabulary for the run setup (DESIGN §1). Thinking levels are
 * named words (低 / 中 / 高 / 很高 / 极限), the default stop names the level the
 * engine runs when that is known (「自动（中）」, else 「自动」), and model descriptions are ours (localized), not the
 * SDK catalog's English marketing lines.
 */
const EFFORT_LEVEL_KEYS: Readonly<Record<string, SimpleTranslationKey>> = {
    low: 'session.chat.effortLevels.low',
    medium: 'session.chat.effortLevels.medium',
    high: 'session.chat.effortLevels.high',
    xhigh: 'session.chat.effortLevels.xhigh',
    max: 'session.chat.effortLevels.max',
    ultra: 'session.chat.effortLevels.ultra',
    minimal: 'session.chat.effortLevels.minimal',
    none: 'session.chat.effortLevels.none',
    off: 'session.chat.effortLevels.off',
};

/** A known backend key's word; anything else (pi's own labels) unchanged. */
export function effortLevelName(key: string, fallback: string, translate: Translate): string {
    const textKey = EFFORT_LEVEL_KEYS[key];
    return textKey ? translate(textKey) : fallback;
}

export function namedEffortOptions(options: readonly ModeOption[], translate: Translate): ModeOption[] {
    return options.map((option) => ({ ...option, name: effortLevelName(option.key, option.name, translate) }));
}

/**
 * The 「自动」 stop: send no level, the engine decides. Named with the level it
 * runs only when that is known (catalog `defaultReasoningEffort`, the Codex
 * wrapper's fixed start level) — never a guess.
 */
export function autoEffortName(engineDefault: string | null | undefined, translate: Translate): string {
    return engineDefault
        ? translate('session.chat.effortAuto', { level: effortLevelName(engineDefault, engineDefault, translate) })
        : translate('session.chat.effortAutoPlain');
}

const DESC_KEYS: Readonly<Record<string, SimpleTranslationKey>> = {
    opus: 'session.chat.modelPicker.desc.opus',
    sonnet: 'session.chat.modelPicker.desc.sonnet',
    haiku: 'session.chat.modelPicker.desc.haiku',
    fable: 'session.chat.modelPicker.desc.fable',
    best: 'session.chat.modelPicker.desc.best',
    opusplan: 'session.chat.modelPicker.desc.opusplan',
    'codex:astra': 'session.chat.modelPicker.desc.astra',
    'codex:sol': 'session.chat.modelPicker.desc.sol',
    'codex:terra': 'session.chat.modelPicker.desc.terra',
    'codex:luna': 'session.chat.modelPicker.desc.luna',
};

/**
 * Our description for Claude/Codex entries: the family line, 「旧版本」 under
 * the newest of the family, the 1M hint on `[1m]` twins. Entries we know
 * nothing about (custom ids, plain gpt-5.x) lose the catalog's English text
 * only when it is the SDK's — the follow / machine-config / custom entries
 * keep the descriptions their callers already localized.
 */
export function localizeModelDescriptions(
    flavor: string | null | undefined,
    options: readonly ModeOption[],
    input: {
        resolved?: (key: string) => string | null | undefined;
        keep: ReadonlySet<string>;
        /** The wrapper's catalog keys: 「旧版本」 is relative to what it can run. */
        runnable?: ReadonlySet<string> | null;
        translate: Translate;
    },
): ModeOption[] {
    const agent = normalizeAgentKey(flavor);
    if (agent !== 'claude' && agent !== 'codex') return [...options];
    const { translate } = input;
    const newest = new Map<string, number[]>();
    // QA26 P2-5: an untiered Codex id (gpt-5.5, gpt-5.3-codex) is 「旧版本」 next to a newer tiered one.
    let newestCodex: number[] | null = null;
    const parsed = options.map((option) => {
        if (option.key === LATEST_MODEL_MODE || option.key === 'default') return null;
        const base = option.key.endsWith(LONG_CONTEXT_SUFFIX) ? option.key.slice(0, -LONG_CONTEXT_SUFFIX.length) : option.key;
        const family = modelFamilyOf(flavor, { ...option, key: base }, input.resolved?.(base));
        const runnable = !input.runnable?.size || input.runnable.has(base);
        if (family && runnable) {
            const seen = newest.get(family.family);
            if (!seen || compare(family.version, seen) > 0) newest.set(family.family, family.version);
            if (agent === 'codex' && (!newestCodex || compare(family.version, newestCodex) > 0)) newestCodex = family.version;
        }
        return family;
    });
    return options.map((option, index) => {
        if (input.keep.has(option.key)) return option;
        const family = parsed[index];
        const longContext = option.key.endsWith(LONG_CONTEXT_SUFFIX);
        if (option.key === LATEST_MODEL_MODE || option.key === 'default') return option;
        const own = family ? DESC_KEYS[family.family] : DESC_KEYS[option.key];
        let description: string | null = own ? translate(own) : null;
        const newestOfFamily = family ? newest.get(family.family) : undefined;
        if (family && newestOfFamily && compare(family.version, newestOfFamily) < 0) description = translate('session.chat.modelPicker.desc.older');
        // `gpt-5.3-codex` parses as a family of its own but is no named tier.
        const untiered = agent === 'codex' && (!family || !DESC_KEYS[family.family]) ? codexVersion(option.key) : null;
        if (untiered && newestCodex && compare(untiered, newestCodex) < 0) description = translate('session.chat.modelPicker.desc.older');
        if (longContext) description = [description, translate('session.chat.modelPicker.longContextHint')].filter(Boolean).join(' · ');
        return { ...option, description };
    });
}

function codexVersion(key: string): number[] | null {
    const match = /^gpt-(\d+(?:\.\d+)?)(?:-|$)/.exec(key);
    return match ? match[1].split('.').map(Number) : null;
}

/**
 * QA26 P2-5: one way to write a model name, whatever the source (Codex's own
 * `model/list` says 「GPT-6.1 Terra」, the static list `gpt-6.1-sol`): Codex ids
 * as `GPT-6.1-Terra`; Claude's alias-of-pinned entry with a localized
 * 「（别名）」 instead of English.
 */
export function localizeModelNames(flavor: string | null | undefined, options: readonly ModeOption[], translate: Translate): ModeOption[] {
    const agent = normalizeAgentKey(flavor);
    return options.map((option) => {
        if (option.key === LATEST_MODEL_MODE || option.key === 'default') return option;
        if (agent === 'codex') {
            const name = codexModelName(option.key);
            return name ? { ...option, name } : option;
        }
        if (agent === 'claude') {
            const alias = /^(.+?) \(alias(, 1M context)?\)( · 1M)?$/.exec(option.name);
            if (alias) return { ...option, name: `${alias[1]}${translate('session.chat.modelPicker.aliasSuffix')}${alias[2] || alias[3] ? ' · 1M' : ''}` };
        }
        return option;
    });
}

/** `gpt-6.1-terra` → `GPT-6.1-Terra`, `gpt-5.1-codex-max` → `GPT-5.1-Codex-Max`; other ids: null. */
export function codexModelName(key: string): string | null {
    const match = /^gpt-(\d+(?:\.\d+)?)((?:-[a-z]+)*)$/.exec(key);
    if (!match) return null;
    const rest = match[2].split('-').filter(Boolean).map((part) => part[0].toUpperCase() + part.slice(1));
    return ['GPT', match[1], ...rest].join('-');
}

function compare(a: number[], b: number[]): number {
    for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
        const diff = (a[i] ?? 0) - (b[i] ?? 0);
        if (diff !== 0) return diff;
    }
    return 0;
}
