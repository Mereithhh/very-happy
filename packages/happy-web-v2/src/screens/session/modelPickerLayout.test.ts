import { describe, expect, it } from 'vitest';
import type { ModeOption } from '@/components/modelModeOptions';
import { catalogRunnableKeys, getAvailableModels, getClaudeModelModes } from '@/components/modelModeOptions';
import { layoutModelPicker, listedModelKey, longContextLocked, longContextRowPick, modelFamilyOf, withLongContextTwins } from './modelPickerLayout';
import { localizeModelDescriptions, autoEffortName, namedEffortOptions } from './runSetupCopy';

// Catalog a Claude session published on 2026-10-31 (CLI 0.2.189, Claude Code 2.1.304).
const CLAUDE_CATALOG = [
    ['default', 'Default (recommended)', 'claude-fable-5-1'],
    ['opus', 'Opus 5.5', 'claude-opus-5-5'],
    ['fable', 'Fable 5.1', 'claude-fable-5-1'],
    ['sonnet', 'Sonnet 5.5', 'claude-sonnet-5-5'],
    ['haiku', 'Haiku 5.5', 'claude-haiku-5-5'],
    ['claude-haiku-4-5-20251001', 'Haiku 4.5', 'claude-haiku-4-5-20251001'],
    ['claude-sonnet-5', 'Sonnet 5', 'claude-sonnet-5'],
    ['claude-opus-5', 'Opus 5', 'claude-opus-5'],
    ['claude-fable-5', 'Fable 5', 'claude-fable-5'],
    ['claude-opus-4-8', 'Opus 4.8', 'claude-opus-4-8'],
    ['claude-sonnet-4-6', 'Sonnet 4.6', 'claude-sonnet-4-6'],
] as const;
const resolved = (key: string) => CLAUDE_CATALOG.find(([code]) => code === key)?.[2] ?? null;
// What the composer lists while following latest (Opus 5.5 collapsed into the entry).
const claudeOptions: ModeOption[] = [
    { key: 'latest', name: 'Latest · Opus 5.5' },
    { key: 'default', name: 'Machine config · Fable 5.1' },
    { key: 'claude-opus-5-5[1m]', name: 'Opus 5.5 · 1M' },
    ...CLAUDE_CATALOG.filter(([code]) => code !== 'default').map(([key, name]) => ({ key, name })),
];
const runnable = new Set([...CLAUDE_CATALOG.map(([code]) => code), 'claude-opus-5-5']);
const keys = (list: ModeOption[]) => list.map((option) => option.key);

describe('layoutModelPicker (B-849a)', () => {
    it('Claude: the two defaults, then the newest Fable · Sonnet · Haiku; Opus is the follow entry; the rest under 更多模型', () => {
        const layout = layoutModelPicker(claudeOptions, { flavor: 'claude', selectedKey: 'latest', followModel: 'claude-opus-5-5', resolved, runnable });
        expect(keys(layout.primary)).toEqual(['latest', 'default', 'fable', 'sonnet', 'haiku']);
        // `default` resolves to Fable 5.1 but is never a family pick, and the 1M twin rides on the switch.
        expect(keys(layout.more)).toEqual(['opus', 'claude-haiku-4-5-20251001', 'claude-sonnet-5', 'claude-opus-5', 'claude-fable-5', 'claude-opus-4-8', 'claude-sonnet-4-6']);
        expect(layout.longContext).toEqual({ on: false, onKey: 'claude-opus-5-5[1m]', offKey: 'latest' });
        expect(layout.selectedInMore).toBe(false);
    });

    it('a pinned Opus 5.5 is the family pick over the alias resolving to it; its 1M twin turns the switch on/off', () => {
        // the alias comes first in the list: the tie-break, not list order, picks the pinned id
        const options = [...claudeOptions.filter((o) => o.key !== 'latest'), { key: 'claude-opus-5-5', name: 'Opus 5.5' }];
        const on = layoutModelPicker(options, { flavor: 'claude', selectedKey: 'claude-opus-5-5[1m]', resolved, runnable });
        expect(keys(on.primary)).toEqual(['default', 'claude-opus-5-5', 'fable', 'sonnet', 'haiku']);
        expect(keys(on.more)).toContain('opus');
        expect(on.longContext).toEqual({ on: true, onKey: 'claude-opus-5-5[1m]', offKey: 'claude-opus-5-5' });
        expect(listedModelKey(on, 'claude-opus-5-5[1m]')).toBe('claude-opus-5-5');
        // an old version stays reachable and opens 更多模型
        const old = layoutModelPicker(options, { flavor: 'claude', selectedKey: 'claude-opus-4-8', resolved, runnable });
        expect(old.selectedInMore).toBe(true);
        expect(old.longContext).toBeNull();
    });

    it('Codex: one per named tier among what the wrapper lists; bundled extras and untiered ids go under 更多模型', () => {
        const options: ModeOption[] = ['latest', 'gpt-6-sol', 'gpt-6-luna', 'gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.2'].map((key) => ({ key, name: key }));
        const catalog = new Set(['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.2']);
        const layout = layoutModelPicker(options, { flavor: 'codex', selectedKey: 'latest', followModel: 'gpt-5.6-sol', runnable: catalog });
        expect(keys(layout.primary)).toEqual(['latest', 'gpt-6-astra', 'gpt-5.6-terra', 'gpt-5.6-luna']);
        expect(keys(layout.more)).toEqual(['gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.5', 'gpt-5.2']);
        expect(layout.longContext).toBeNull();
    });

    it('custom models stay on top; agents without families keep their list as is', () => {
        const layout = layoutModelPicker([...claudeOptions, { key: 'gw/opus', name: 'gw/opus' }], { flavor: 'claude', selectedKey: 'gw/opus', followModel: 'claude-opus-5-5', resolved, runnable, customKeys: ['gw/opus'] });
        expect(keys(layout.primary).at(-1)).toBe('gw/opus');
        const pi = layoutModelPicker([{ key: 'a', name: 'a' }, { key: 'b', name: 'b' }], { flavor: 'acp', selectedKey: 'a' });
        expect(keys(pi.primary)).toEqual(['a', 'b']);
        expect(pi.more).toEqual([]);
    });

    it('families come from resolved ids, dated ids and versioned alias names', () => {
        const datedId = CLAUDE_CATALOG[5][0]; // claude-haiku-4-5-<date>
        expect(modelFamilyOf('claude', { key: datedId, name: 'x' })).toEqual({ family: 'haiku', version: [4, 5] });
        expect(modelFamilyOf('claude', { key: 'sonnet', name: 'Sonnet 5.5' })).toEqual({ family: 'sonnet', version: [5, 5] });
        expect(modelFamilyOf('claude', { key: 'opus', name: 'opus (alias)' })).toBeNull();
        expect(modelFamilyOf('claude', { key: 'best', name: 'best' })).toBeNull();
        expect(modelFamilyOf('codex', { key: 'gpt-5.6-terra', name: 'x' })).toEqual({ family: 'codex:terra', version: [5, 6] });
        expect(modelFamilyOf('codex', { key: 'gpt-5.5', name: 'x' })).toBeNull();
    });

    it('adds the [1m] twins Claude Code accepts, once, only for Claude', () => {
        const out = withLongContextTwins('claude', [{ key: 'sonnet', name: 'Sonnet 5.5' }, { key: 'haiku', name: 'Haiku 5.5' }, { key: 'fable', name: 'Fable 5.1' }, { key: 'fable[1m]', name: 'given' }], '1M');
        expect(out.map((o) => `${o.key}=${o.name}`)).toEqual(['sonnet=Sonnet 5.5', 'sonnet[1m]=Sonnet 5.5 · 1M', 'haiku=Haiku 5.5', 'fable=Fable 5.1', 'fable[1m]=given']);
        expect(withLongContextTwins('codex', [{ key: 'opus', name: 'x' }], '1M')).toHaveLength(1);
    });
});

describe('run setup copy (B-849a)', () => {
    const t = ((key: string, params?: Record<string, string>) => params ? `${key}(${Object.values(params).join(',')})` : key) as never;

    it('names thinking levels and the auto stop by what the engine runs', () => {
        expect(namedEffortOptions([{ key: 'xhigh', name: 'xhigh' }, { key: 'Thinking: off', name: 'Thinking: off' }], t).map((o) => o.name))
            .toEqual(['session.chat.effortLevels.xhigh', 'Thinking: off']);
        expect(autoEffortName('high', t)).toBe('session.chat.effortAuto(session.chat.effortLevels.high)');
        expect(autoEffortName(null, t)).toBe('session.chat.effortAutoPlain');
    });

    it('replaces catalog English with family lines, marks older versions relative to what the wrapper runs', () => {
        const options: ModeOption[] = [
            { key: 'latest', name: 'L', description: 'kept' },
            { key: 'sonnet', name: 'Sonnet 5.5', description: 'Most efficient for simpler tasks' },
            { key: 'claude-sonnet-4-6', name: 'Sonnet 4.6', description: 'Efficient for routine tasks' },
            { key: 'sonnet[1m]', name: 'Sonnet 5.5 · 1M' },
            { key: 'gw/x', name: 'gw/x', description: 'custom' },
        ];
        const out = localizeModelDescriptions('claude', options, { resolved, keep: new Set(['latest', 'gw/x']), translate: t });
        expect(out.map((o) => o.description)).toEqual([
            'kept',
            'session.chat.modelPicker.desc.sonnet',
            'session.chat.modelPicker.desc.older',
            'session.chat.modelPicker.desc.sonnet · session.chat.modelPicker.longContextHint',
            'custom',
        ]);
        // A bundled extra the wrapper cannot run does not make its catalog sibling "older".
        const codex = localizeModelDescriptions('codex', [{ key: 'gpt-6-sol', name: 'a' }, { key: 'gpt-5.6-sol', name: 'b' }], { keep: new Set(), runnable: new Set(['gpt-5.6-sol']), translate: t });
        expect(codex.map((o) => o.description)).toEqual(['session.chat.modelPicker.desc.sol', 'session.chat.modelPicker.desc.sol']);
    });
});

describe('B-883: following a [1m] id (Claude default, or a machine config like opus[1m])', () => {
    // What the composer lists then: the follow entry stands for Opus 5.5 and its 1M twin.
    const followOptions = claudeOptions.filter((option) => option.key !== 'claude-opus-5-5[1m]');
    it('the switch shows on; switching it off pins the plain id', () => {
        const layout = layoutModelPicker(followOptions, { flavor: 'claude', selectedKey: 'latest', followModel: 'claude-opus-5-5[1m]', resolved, runnable });
        expect(keys(layout.primary)).toEqual(['latest', 'default', 'fable', 'sonnet', 'haiku']);
        expect(layout.longContext).toEqual({ on: true, onKey: 'latest', offKey: 'claude-opus-5-5' });
        const config = layoutModelPicker(followOptions, { flavor: 'claude', selectedKey: 'latest', followModel: 'opus[1m]', resolved, runnable });
        expect(config.longContext).toEqual({ on: true, onKey: 'latest', offKey: 'opus' });
    });
    it('1M switched off is a pin: listed on top, switch off, switching on follows latest again', () => {
        const off = layoutModelPicker([...followOptions, { key: 'claude-opus-5-5', name: 'Opus 5.5' }], { flavor: 'claude', selectedKey: 'claude-opus-5-5', followModel: 'claude-opus-5-5[1m]', resolved, runnable });
        expect(keys(off.primary)).toContain('claude-opus-5-5');
        expect(off.longContext).toEqual({ on: false, onKey: 'latest', offKey: 'claude-opus-5-5' });
    });
    it('a machine config without 1M shows the switch off', () => {
        const withTwin = layoutModelPicker([...claudeOptions, { key: 'opus[1m]', name: 'opus · 1M' }], { flavor: 'claude', selectedKey: 'latest', followModel: 'opus', resolved, runnable });
        expect(withTwin.longContext).toEqual({ on: false, onKey: 'opus[1m]', offKey: 'latest' });
    });
});

describe('QA26 P2-4: 1M pinned on the followed model', () => {
    it('lists the base row on top and checks it, with the switch on', () => {
        const options = [...claudeOptions, { key: 'claude-opus-5-5', name: 'Opus 5.5' }];
        const on = layoutModelPicker(options, { flavor: 'claude', selectedKey: 'claude-opus-5-5[1m]', followModel: 'claude-opus-5-5', resolved, runnable });
        expect(keys(on.primary)).toEqual(['latest', 'default', 'claude-opus-5-5', 'fable', 'sonnet', 'haiku']);
        expect(listedModelKey(on, 'claude-opus-5-5[1m]')).toBe('claude-opus-5-5');
        expect(on.longContext).toEqual({ on: true, onKey: 'claude-opus-5-5[1m]', offKey: 'claude-opus-5-5' });
        expect(on.selectedInMore).toBe(false);
    });
});

describe('B-883b: following latest on a machine that refused 1M', () => {
    it('the follow entry is the plain id: the switch shows off and turning it on pins the [1m] twin', () => {
        const layout = layoutModelPicker(claudeOptions, { flavor: 'claude', selectedKey: 'latest', followModel: 'claude-opus-5-5', resolved, runnable });
        expect(layout.longContext).toEqual({ on: false, onKey: 'claude-opus-5-5[1m]', offKey: 'latest' });
    });
});

describe('B-893: Fable and the gpt-6 generation on the top list', () => {
    const t = ((key: string) => key) as never;
    it('Claude (SDK 0.3.318 catalog, Fable only as claude-fable-5-1[1m]): Opus and Fable both on top, Fable with its 1M switch', () => {
        const metadata = { models: [
            { code: 'default', value: 'Default (recommended)', resolvedModel: 'claude-opus-5-5' },
            { code: 'opus', value: 'Opus 5.5', resolvedModel: 'claude-opus-5-5' },
            { code: 'claude-fable-5-1[1m]', value: 'Fable', resolvedModel: 'claude-fable-5-1' },
            { code: 'sonnet', value: 'Sonnet 5', resolvedModel: 'claude-sonnet-5' },
            { code: 'haiku', value: 'Haiku 4.5', resolvedModel: 'claude-haiku-4-5' },
        ], capabilities: ['claude-opus-5-5-v1'] } as never;
        const listed = getAvailableModels('claude', metadata, t);
        const catalogResolved = (key: string) => (metadata as { models: { code: string; resolvedModel: string }[] }).models.find((m) => m.code === key)?.resolvedModel ?? null;
        const run = catalogRunnableKeys('claude', (metadata as { models: { code: string }[] }).models.map((m) => m.code));
        // Pinned Opus 5.5 (not following latest).
        const pinned = layoutModelPicker(listed, { flavor: 'claude', selectedKey: 'claude-opus-5-5', resolved: catalogResolved, runnable: run });
        expect(keys(pinned.primary)).toEqual(['default', 'claude-opus-5-5', 'claude-fable-5-1', 'sonnet', 'haiku']);
        expect(keys(pinned.more)).not.toContain('claude-fable-5-1[1m]');
        const fable = layoutModelPicker(listed, { flavor: 'claude', selectedKey: 'claude-fable-5-1[1m]', resolved: catalogResolved, runnable: run });
        expect(fable.longContext).toEqual({ on: true, onKey: 'claude-fable-5-1[1m]', offKey: 'claude-fable-5-1' });
        expect(fable.selectedInMore).toBe(false);
        // Following latest Opus 5.5: the follow entry stands for Opus, Fable stays on top.
        const follow = layoutModelPicker([{ key: 'latest', name: 'Latest · Opus 5.5' }, ...listed], { flavor: 'claude', selectedKey: 'latest', followModel: 'claude-opus-5-5', resolved: catalogResolved, runnable: run });
        expect(keys(follow.primary).slice(0, 3)).toEqual(['latest', 'default', 'claude-fable-5-1']);
    });
    it('B-907 (SDK 0.3.322 wrapper, subscription catalog still lists claude-fable-5-1[1m]): Fable 5.2 is the family pick with its 1M switch, 5.1 under 更多模型', () => {
        const metadata = { models: [
            { code: 'default', value: 'Default (recommended)', resolvedModel: 'claude-opus-5-5' },
            { code: 'opus', value: 'Opus', resolvedModel: 'claude-opus-5-5' },
            { code: 'claude-fable-5-1[1m]', value: 'Fable', resolvedModel: 'claude-fable-5-1' },
            { code: 'sonnet', value: 'Sonnet 5', resolvedModel: 'claude-sonnet-5' },
            { code: 'haiku', value: 'Haiku', resolvedModel: 'claude-haiku-4-5' },
        ], capabilities: ['claude-opus-5-5-v1', 'claude-fable-5-2-v1'] } as never;
        const listed = getAvailableModels('claude', metadata, t);
        const catalogResolved = (key: string) => (metadata as { models: { code: string; resolvedModel: string }[] }).models.find((m) => m.code === key)?.resolvedModel ?? null;
        const run = catalogRunnableKeys('claude', (metadata as { models: { code: string }[] }).models.map((m) => m.code), { claudeFable52: true });
        const pinned = layoutModelPicker(listed, { flavor: 'claude', selectedKey: 'claude-opus-5-5', resolved: catalogResolved, runnable: run });
        expect(keys(pinned.primary)).toEqual(['default', 'claude-opus-5-5', 'claude-fable-5-2', 'sonnet', 'haiku']);
        expect(keys(pinned.more)).toContain('claude-fable-5-1');
        const fable = layoutModelPicker(listed, { flavor: 'claude', selectedKey: 'claude-fable-5-2[1m]', resolved: catalogResolved, runnable: run });
        expect(fable.longContext).toEqual({ on: true, onKey: 'claude-fable-5-2[1m]', offKey: 'claude-fable-5-2' });
        // A session already on Fable 5.1 still finds (and shows) it, with its 1M switch.
        const old = layoutModelPicker(listed, { flavor: 'claude', selectedKey: 'claude-fable-5-1[1m]', resolved: catalogResolved, runnable: run });
        expect(old.selectedInMore).toBe(true);
        expect(old.longContext).toEqual({ on: true, onKey: 'claude-fable-5-1[1m]', offKey: 'claude-fable-5-1' });
        // Same catalog from an SDK 0.3.318 wrapper (no claude-fable-5-2-v1): unchanged, Fable 5.1 on top.
        const legacy = { ...(metadata as object), capabilities: ['claude-opus-5-5-v1'] } as never;
        const legacyRun = catalogRunnableKeys('claude', (metadata as { models: { code: string }[] }).models.map((m) => m.code), { claudeFable52: false });
        const before = layoutModelPicker(getAvailableModels('claude', legacy, t), { flavor: 'claude', selectedKey: 'claude-opus-5-5', resolved: catalogResolved, runnable: legacyRun });
        expect(keys(before.primary)).toEqual(['default', 'claude-opus-5-5', 'claude-fable-5-1', 'sonnet', 'haiku']);
    });
    it('B-907 (SDK 0.3.322 on an API-key provider): the `fable` alias resolving to claude-fable-5-2 is Fable\'s family pick', () => {
        const metadata = { models: [
            { code: 'default', value: 'Default (recommended)', resolvedModel: 'claude-opus-5-5' },
            { code: 'opus', value: 'Opus 5.5', resolvedModel: 'claude-opus-5-5' },
            { code: 'fable', value: 'Fable', resolvedModel: 'claude-fable-5-2' },
            { code: 'sonnet', value: 'Sonnet 5', resolvedModel: 'claude-sonnet-5' },
            { code: 'haiku', value: 'Haiku 4.5', resolvedModel: 'claude-haiku-4-5' },
        ], capabilities: ['claude-opus-5-5-v1', 'claude-fable-5-2-v1'] } as never;
        const listed = getAvailableModels('claude', metadata, t);
        const catalogResolved = (key: string) => (metadata as { models: { code: string; resolvedModel: string }[] }).models.find((m) => m.code === key)?.resolvedModel ?? null;
        const run = catalogRunnableKeys('claude', (metadata as { models: { code: string }[] }).models.map((m) => m.code), { claudeFable52: true });
        const layout = layoutModelPicker(listed, { flavor: 'claude', selectedKey: 'claude-opus-5-5', resolved: catalogResolved, runnable: run });
        expect(keys(layout.primary)).toEqual(['default', 'claude-opus-5-5', 'claude-fable-5-2', 'sonnet', 'haiku']);
        expect(keys(layout.more)).toContain('fable');
    });
    it('Codex 0.154 catalog: the newest of each tier is a gpt-6 model, even the ones its Codex does not bundle', () => {
        const codes = ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.2'];
        const listed = getAvailableModels('codex', { models: codes.map((code) => ({ code, value: code })) } as never, t);
        const layout = layoutModelPicker(listed, { flavor: 'codex', selectedKey: 'default', runnable: catalogRunnableKeys('codex', codes) });
        expect(keys(layout.primary)).toEqual(['default', 'gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-luna', 'gpt-6-astra']);
        expect(keys(layout.more)).toEqual(expect.arrayContaining(['gpt-6-sol', 'gpt-5.6-sol', 'gpt-5.5']));
    });
});

describe('B-908 longContextRowPick: a Claude pick with a 1M twin takes the twin', () => {
    const claudeKeys = new Set(withLongContextTwins('claude', getClaudeModelModes(), '1M').map((option) => option.key));
    const pick = (key: string, over: Partial<Parameters<typeof longContextRowPick>[1]> = {}) =>
        longContextRowPick(key, { flavor: 'claude', optionKeys: claudeKeys, optOut: false, unsupported: false, ...over });

    it('default on for Opus 5.5, Fable 5.2, Fable 5.1 and the opus / fable aliases', () => {
        expect(pick('claude-opus-5-5')).toBe('claude-opus-5-5[1m]');
        expect(pick('claude-fable-5-2')).toBe('claude-fable-5-2[1m]');
        expect(pick('claude-fable-5-1')).toBe('claude-fable-5-1[1m]');
        expect(pick('opus')).toBe('opus[1m]');
        expect(pick('fable')).toBe('fable[1m]');
    });

    it('switched off once (account opt-out) → plain ids, never turned on again by a pick', () => {
        for (const key of ['claude-opus-5-5', 'claude-fable-5-2', 'claude-fable-5-1', 'opus', 'fable']) expect(pick(key, { optOut: true })).toBe(key);
    });

    it('a provider that refused 1M (B-883b, also older CLIs on such an account) → plain', () => {
        expect(pick('claude-fable-5-2', { unsupported: true })).toBe('claude-fable-5-2');
    });

    it('models without a default-on 1M (Sonnet: no 5.5 1M in CC’s catalog; Haiku: none) and non-model entries are unchanged', () => {
        for (const key of ['sonnet', 'haiku', 'best', 'opusplan', 'default', 'latest', 'claude-fable-5-2[1m]']) expect(pick(key)).toBe(key);
    });

    it('no twin listed → the plain id (an older wrapper whose picker lacks it)', () => {
        expect(pick('claude-fable-5-2', { optionKeys: new Set(['claude-fable-5-2']) })).toBe('claude-fable-5-2');
    });

    it('Codex / pi / Gemini picks pass through', () => {
        for (const flavor of ['codex', 'acp', 'gemini']) expect(pick('claude-opus-5-5', { flavor })).toBe('claude-opus-5-5');
    });
});

describe('B-908 longContextLocked: the switch would change nothing', () => {
    const NEW = ['claude-opus-5-5-v1', 'claude-fable-5-2-v1'];
    const OLD = ['claude-opus-5-5-v1'];
    const locked = (selectedModel: string, running: string, contextWindow: number | undefined, capabilities = NEW, flavor = 'claude') =>
        longContextLocked({ flavor, selectedModel, running, contextWindow, capabilities });

    it('CC 2.1.322 (reports 1M): Opus 5.5, Fable 5.1, Fable 5.2, Sonnet 5 / 5.5 — plain or [1m] — are locked on', () => {
        for (const id of ['claude-opus-5-5', 'claude-fable-5-1', 'claude-fable-5-2', 'claude-sonnet-5', 'claude-sonnet-5-5']) {
            expect(locked(id, id, 1_000_000)).toBe(true);
            expect(locked(`${id}[1m]`, id, 1_000_000)).toBe(true);
        }
    });

    it('older CC (no Fable 5.2 capability): Fable 5.2 keeps a working switch — off really means 200k', () => {
        expect(locked('claude-fable-5-2[1m]', 'claude-fable-5-2', 1_000_000, OLD)).toBe(false);
        expect(locked('claude-fable-5-2', 'claude-fable-5-2', 200_000, OLD)).toBe(false);
        expect(locked('claude-opus-5-5', 'claude-opus-5-5', 1_000_000, OLD)).toBe(true);
    });

    it('no reported window (old CLI), a 200k window, another model still running, Haiku, Codex → not locked', () => {
        expect(locked('claude-fable-5-2', 'claude-fable-5-2', undefined)).toBe(false);
        expect(locked('claude-fable-5-2', 'claude-fable-5-2', 200_000)).toBe(false);
        expect(locked('claude-fable-5-2[1m]', 'claude-opus-5-5', 1_000_000)).toBe(false);
        expect(locked('claude-haiku-4-5', 'claude-haiku-4-5', 1_000_000)).toBe(false);
        expect(locked('claude-opus-5-5', 'claude-opus-5-5', 1_000_000, NEW, 'codex')).toBe(false);
    });
});
