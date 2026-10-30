import { LATEST_MODEL_MODE } from '@slopus/happy-wire';
import type { ModeOption } from '@/components/modelModeOptions';
import { normalizeAgentKey } from '@/sync/agentDefaults';

/**
 * B-849a: the model picker lists the newest model of each family (Claude:
 * Opus · Sonnet · Haiku · Fable; Codex: one per named tier) next to the two
 * defaults, folds `[1m]` twins into a 「1M 上下文」 switch and puts every older
 * version and alias under 「更多模型」. Nothing is dropped: a session already
 * on an alias or an old version still finds (and shows) it.
 */
export type ModelFamily = 'opus' | 'sonnet' | 'haiku' | 'fable' | `codex:${string}`;

export type ModelPickerLayout = {
    primary: ModeOption[];
    more: ModeOption[];
    /** 1M switch for the selected entry; null when it has no 1M twin. */
    longContext: { on: boolean; onKey: string; offKey: string } | null;
    /** The selected key lives under 「更多模型」 (the section opens with it). */
    selectedInMore: boolean;
};

export const LONG_CONTEXT_SUFFIX = '[1m]';

const CLAUDE_FAMILY_ORDER: readonly ModelFamily[] = ['opus', 'sonnet', 'haiku', 'fable'];
/** Keys Claude Code accepts with the 1M marker (the pre-B-849a list offered exactly these). */
const CLAUDE_LONG_CONTEXT_BASES: ReadonlySet<string> = new Set(['claude-opus-5-5', 'opus', 'sonnet', 'fable']);

const baseKey = (key: string) => key.endsWith(LONG_CONTEXT_SUFFIX) ? key.slice(0, -LONG_CONTEXT_SUFFIX.length) : key;

function parseVersion(text: string): number[] | null {
    const parts = text.split(/[.-]/).filter(Boolean).map(Number);
    return parts.length > 0 && parts.every((part) => Number.isInteger(part)) ? parts : null;
}

function compareVersions(a: number[], b: number[]): number {
    for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
        const diff = (a[i] ?? 0) - (b[i] ?? 0);
        if (diff !== 0) return diff;
    }
    return 0;
}

/**
 * Family and version of one picker entry. Claude: the resolved id
 * (`claude-opus-5-5`, dated ids too) or an alias named with its version
 * ("Sonnet 5.5"); Codex: `gpt-<version>-<tier>`. Untiered entries (`best`,
 * `opusplan`, plain `gpt-5.5`, custom ids) have none.
 */
export function modelFamilyOf(
    flavor: string | null | undefined,
    option: ModeOption,
    resolvedModel?: string | null,
): { family: ModelFamily; version: number[] } | null {
    const key = baseKey(option.key);
    if (normalizeAgentKey(flavor) === 'codex') {
        const match = /^gpt-(\d+(?:\.\d+)?)-([a-z]+)$/.exec(key);
        const version = match ? parseVersion(match[1]) : null;
        return match && version ? { family: `codex:${match[2]}`, version } : null;
    }
    if (normalizeAgentKey(flavor) !== 'claude') return null;
    const id = baseKey(resolvedModel ?? key);
    const pinned = /^claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(id);
    if (pinned) {
        return { family: pinned[1] as ModelFamily, version: [Number(pinned[2]), ...(pinned[3] ? [Number(pinned[3])] : [])] };
    }
    if (!(CLAUDE_FAMILY_ORDER as readonly string[]).includes(key)) return null;
    const named = /(\d+(?:\.\d+)?)/.exec(option.name);
    const version = named ? parseVersion(named[1]) : null;
    return version ? { family: key as ModelFamily, version } : null;
}

/**
 * Claude Code takes `<alias>[1m]` for these; a live catalog lists only the
 * bare alias, so the twin is added here (named after its base) for the 1M
 * switch to land on a real entry.
 */
export function withLongContextTwins(flavor: string | null | undefined, options: readonly ModeOption[], suffixLabel: string): ModeOption[] {
    if (normalizeAgentKey(flavor) !== 'claude') return [...options];
    const keys = new Set(options.map((option) => option.key));
    const out: ModeOption[] = [];
    for (const option of options) {
        out.push(option);
        const twin = option.key + LONG_CONTEXT_SUFFIX;
        if (CLAUDE_LONG_CONTEXT_BASES.has(option.key) && !keys.has(twin)) {
            out.push({ key: twin, name: `${option.name} · ${suffixLabel}`, description: option.description ?? null });
            keys.add(twin);
        }
    }
    return out;
}

export function layoutModelPicker(options: readonly ModeOption[], input: {
    flavor: string | null | undefined;
    /** The entry the picker shows as selected. */
    selectedKey: string | null | undefined;
    /** What the follow entry runs (followEntryModel): its family is represented by that entry. */
    followModel?: string | null;
    /** Catalog alias → resolved id (Claude `opus` → `claude-opus-5-5`). */
    resolved?: (key: string) => string | null | undefined;
    /** Keys the wrapper's own catalog lists; when present only these can be a family's newest. */
    runnable?: ReadonlySet<string> | null;
    /** Machine custom models (B-688) stay on top. */
    customKeys?: readonly string[];
}): ModelPickerLayout {
    const agent = normalizeAgentKey(input.flavor);
    const keys = new Set(options.map((option) => option.key));
    const selected = input.selectedKey ?? null;
    const longContext = longContextSwitch(keys, selected, input.followModel ?? null);
    if (agent !== 'claude' && agent !== 'codex') {
        return { primary: [...options], more: [], longContext, selectedInMore: false };
    }
    const custom = new Set(input.customKeys ?? []);
    const followFamily = input.followModel
        ? modelFamilyOf(input.flavor, { key: input.followModel, name: input.followModel }, input.followModel)?.family ?? null
        : null;
    const resolvedOf = (key: string) => input.resolved?.(baseKey(key)) ?? null;
    // Newest entry per family; the follow entry stands for its own family.
    const best = new Map<ModelFamily, { option: ModeOption; version: number[] }>();
    for (const option of options) {
        if (option.key === LATEST_MODEL_MODE || option.key === 'default' || option.key.endsWith(LONG_CONTEXT_SUFFIX)) continue;
        if (custom.has(option.key)) continue;
        if (input.runnable && input.runnable.size > 0 && !input.runnable.has(baseKey(option.key))) continue;
        const parsed = modelFamilyOf(input.flavor, option, resolvedOf(option.key));
        if (!parsed) continue;
        const seen = best.get(parsed.family);
        const cmp = seen ? compareVersions(parsed.version, seen.version) : 1;
        // Same version: a pinned id beats the alias that resolves to it.
        if (cmp > 0 || (cmp === 0 && seen && option.key.startsWith('claude-') && !seen.option.key.startsWith('claude-'))) {
            best.set(parsed.family, { option, version: parsed.version });
        }
    }
    if (followFamily) {
        const newest = best.get(followFamily);
        const followVersion = modelFamilyOf(input.flavor, { key: input.followModel!, name: input.followModel! }, input.followModel)?.version;
        // ...unless it is the selection (QA26 P2-4: 1M pinned on the followed model) — then it stays on top, checked.
        if (newest && followVersion && compareVersions(newest.version, followVersion) <= 0 && newest.option.key !== (selected && baseKey(selected))) best.delete(followFamily);
    }
    const familyPicks = new Set([...best.values()].map((entry) => entry.option.key));
    const order = agent === 'claude' ? CLAUDE_FAMILY_ORDER : null;
    const primary: ModeOption[] = [];
    const more: ModeOption[] = [];
    for (const option of options) {
        if (option.key === LATEST_MODEL_MODE || option.key === 'default') primary.push(option);
    }
    const picks = options.filter((option) => familyPicks.has(option.key));
    if (order) picks.sort((a, b) => order.indexOf(familyOf(a)) - order.indexOf(familyOf(b)));
    primary.push(...picks);
    for (const option of options) if (custom.has(option.key)) primary.push(option);
    const inPrimary = new Set(primary.map((option) => option.key));
    const riding = (key: string) => key.endsWith(LONG_CONTEXT_SUFFIX) && (keys.has(baseKey(key)) || baseKey(key) === input.followModel);
    for (const option of options) {
        // A 1M twin rides on its base entry's (or the follow entry's) switch.
        if (!inPrimary.has(option.key) && !riding(option.key)) more.push(option);
    }
    const layout = { primary, more, longContext, selectedInMore: false };
    const listed = listedModelKey(layout, selected, input.followModel);
    layout.selectedInMore = !!listed && more.some((option) => option.key === listed);
    return layout;

    function familyOf(option: ModeOption): ModelFamily {
        return modelFamilyOf(input.flavor, option, resolvedOf(option.key))?.family ?? 'opus';
    }
}

/**
 * The switch flips between an entry and its `[1m]` twin. Following latest it
 * pins the followed model's 1M twin; switching that off follows latest again.
 */
function longContextSwitch(keys: ReadonlySet<string>, selected: string | null, followModel: string | null): ModelPickerLayout['longContext'] {
    if (!selected || selected === 'default') return null;
    if (selected.endsWith(LONG_CONTEXT_SUFFIX)) {
        const base = baseKey(selected);
        const offKey = keys.has(base) ? base : base === followModel && keys.has(LATEST_MODEL_MODE) ? LATEST_MODEL_MODE : null;
        return offKey ? { on: true, onKey: selected, offKey } : null;
    }
    const base = selected === LATEST_MODEL_MODE ? followModel : selected;
    if (!base) return null;
    const twin = base + LONG_CONTEXT_SUFFIX;
    return keys.has(twin) ? { on: false, onKey: twin, offKey: selected } : null;
}

/** The entry a `[1m]` selection is listed under (its base), else the key itself. */
export function listedModelKey(layout: ModelPickerLayout, selectedKey: string | null | undefined, followModel?: string | null): string | null {
    if (!selectedKey) return null;
    if (!selectedKey.endsWith(LONG_CONTEXT_SUFFIX)) return selectedKey;
    const base = baseKey(selectedKey);
    const listed = [...layout.primary, ...layout.more];
    if (listed.some((option) => option.key === base)) return base;
    if (base === followModel && listed.some((option) => option.key === LATEST_MODEL_MODE)) return LATEST_MODEL_MODE;
    return selectedKey;
}
