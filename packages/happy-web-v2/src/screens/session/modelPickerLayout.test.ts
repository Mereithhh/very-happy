import { describe, expect, it } from 'vitest';
import type { ModeOption } from '@/components/modelModeOptions';
import { layoutModelPicker, listedModelKey, modelFamilyOf, withLongContextTwins } from './modelPickerLayout';
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
    it('Claude: the two defaults, then the newest Sonnet · Haiku · Fable; Opus is the follow entry; the rest under 更多模型', () => {
        const layout = layoutModelPicker(claudeOptions, { flavor: 'claude', selectedKey: 'latest', followModel: 'claude-opus-5-5', resolved, runnable });
        expect(keys(layout.primary)).toEqual(['latest', 'default', 'sonnet', 'haiku', 'fable']);
        // `default` resolves to Fable 5.1 but is never a family pick, and the 1M twin rides on the switch.
        expect(keys(layout.more)).toEqual(['opus', 'claude-haiku-4-5-20251001', 'claude-sonnet-5', 'claude-opus-5', 'claude-fable-5', 'claude-opus-4-8', 'claude-sonnet-4-6']);
        expect(layout.longContext).toEqual({ on: false, onKey: 'claude-opus-5-5[1m]', offKey: 'latest' });
        expect(layout.selectedInMore).toBe(false);
    });

    it('a pinned Opus 5.5 is the family pick over the alias resolving to it; its 1M twin turns the switch on/off', () => {
        // the alias comes first in the list: the tie-break, not list order, picks the pinned id
        const options = [...claudeOptions.filter((o) => o.key !== 'latest'), { key: 'claude-opus-5-5', name: 'Opus 5.5' }];
        const on = layoutModelPicker(options, { flavor: 'claude', selectedKey: 'claude-opus-5-5[1m]', resolved, runnable });
        expect(keys(on.primary)).toEqual(['default', 'claude-opus-5-5', 'sonnet', 'haiku', 'fable']);
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
