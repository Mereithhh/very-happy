import { describe, expect, it } from 'vitest';
import {
    BUNDLED_LATEST_MODELS,
    LATEST_MODEL_MODE,
    compareTierVersions,
    isResolvedLatestModel,
    parseLatestModelTable,
    resolveLatestModel,
    tierVersion,
    type LatestModelTable,
} from './modelLatest';
import { AGENT_CODE_DEFAULTS, CLAUDE_OPUS_55_CAPABILITY } from './agentCodeDefaults';

const claudeTier = BUNDLED_LATEST_MODELS.agents.claude!;
const codexTier = BUNDLED_LATEST_MODELS.agents.codex!;

// Codex 0.154 / 0.166 bundled `model/list` (probed 2026-10-30, empty CODEX_HOME).
const CODEX_154 = ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.2'].map((code) => ({ code }));
const CODEX_166 = ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-6.1-terra', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5'].map((code) => ({ code }));
// Claude SDK catalog: aliases with resolvedModel.
const CLAUDE_CATALOG = [
    { code: 'default', value: 'Default', resolvedModel: 'claude-opus-5-5' },
    { code: 'opus', value: 'Opus 5.5', resolvedModel: 'claude-opus-5-5' },
    { code: 'fable', value: 'Fable 5.1', resolvedModel: 'claude-fable-5-1' },
    { code: 'sonnet', value: 'Sonnet 5', resolvedModel: 'claude-sonnet-5' },
];

describe('code defaults follow latest', () => {
    it('claude / codex / gemini default to the sentinel, never a concrete id', () => {
        expect(AGENT_CODE_DEFAULTS.claude.modelMode).toBe(LATEST_MODEL_MODE);
        expect(AGENT_CODE_DEFAULTS.codex.modelMode).toBe(LATEST_MODEL_MODE);
        expect(AGENT_CODE_DEFAULTS.gemini.modelMode).toBe(LATEST_MODEL_MODE);
        expect(AGENT_CODE_DEFAULTS.pi.modelMode).toBe('default');
    });
});

describe('tier versions', () => {
    it('parses ids of the tier and rejects other tiers / dated snapshots', () => {
        expect(tierVersion(claudeTier, 'claude-opus-5-5')).toEqual([5, 5]);
        expect(tierVersion(claudeTier, 'claude-opus-5')).toEqual([5]);
        expect(tierVersion(claudeTier, 'claude-opus-4-20250514')).toBeNull();
        expect(tierVersion(claudeTier, 'claude-fable-5-1')).toBeNull();
        expect(tierVersion(claudeTier, 'claude-opus-5-5[1m]')).toBeNull();
        expect(tierVersion(codexTier, 'gpt-6.1-sol')).toEqual([6, 1]);
        expect(tierVersion(codexTier, 'gpt-6-sol')).toEqual([6]);
        expect(tierVersion(codexTier, 'gpt-6-astra')).toBeNull();
        expect(tierVersion(codexTier, 'gpt-6.1-terra')).toBeNull();
    });

    it('compares numerically with missing parts as 0', () => {
        expect(compareTierVersions([6, 1], [6])).toBeGreaterThan(0);
        expect(compareTierVersions([5, 10], [5, 9])).toBeGreaterThan(0);
        expect(compareTierVersions([6], [6, 0])).toBe(0);
        expect(compareTierVersions([5, 6], [6])).toBeLessThan(0);
    });
});

describe('resolveLatestModel — claude (same tier only)', () => {
    it('today: a capable wrapper runs pinned claude-opus-5-5, even before its catalog arrives', () => {
        const r = resolveLatestModel(null, 'claude', { kind: 'session', capabilities: [CLAUDE_OPUS_55_CAPABILITY] });
        expect(r).toMatchObject({ model: 'claude-opus-5-5', newest: 'claude-opus-5-5', limited: false, label: 'Opus 5.5' });
    });

    it('never jumps to Fable or another tier', () => {
        const r = resolveLatestModel(null, 'claude', { kind: 'session', capabilities: [CLAUDE_OPUS_55_CAPABILITY], catalog: CLAUDE_CATALOG });
        expect(r.model).toBe('claude-opus-5-5');
    });

    it('old wrapper without the capability and no catalog → machine default (null), limited', () => {
        const r = resolveLatestModel(null, 'claude', { kind: 'session', capabilities: [] });
        expect(r).toMatchObject({ model: null, newest: 'claude-opus-5-5', limited: true });
    });

    it('old wrapper falls back to the newest Opus its own catalog runs', () => {
        const r = resolveLatestModel(null, 'claude', {
            kind: 'session', capabilities: [],
            catalog: [{ code: 'opus', value: 'Opus 5', resolvedModel: 'claude-opus-5' }],
        });
        expect(r).toMatchObject({ model: 'claude-opus-5', newest: 'claude-opus-5-5', limited: true });
    });

    it('a newer Opus published by the wrapper catalog wins over a stale table', () => {
        const r = resolveLatestModel(null, 'claude', {
            kind: 'session', capabilities: [CLAUDE_OPUS_55_CAPABILITY],
            catalog: [{ code: 'opus', value: 'Opus 6', resolvedModel: 'claude-opus-6' }],
        });
        expect(r).toMatchObject({ model: 'claude-opus-6', newest: 'claude-opus-6', limited: false });
    });

    it('a server table entry the wrapper cannot prove is not sent', () => {
        const table: LatestModelTable = {
            version: 2,
            agents: { claude: { ...claudeTier, models: [{ model: 'claude-opus-6', requires: { capability: 'claude-opus-6-v1' } }, ...claudeTier.models] } },
        };
        const r = resolveLatestModel(table, 'claude', { kind: 'session', capabilities: [CLAUDE_OPUS_55_CAPABILITY] });
        expect(r).toMatchObject({ model: 'claude-opus-5-5', newest: 'claude-opus-6', limited: true });
        expect(resolveLatestModel(table, 'claude', { kind: 'session', capabilities: ['claude-opus-6-v1'] }).model).toBe('claude-opus-6');
    });

    it('machine context: an old CLI version rules the entry out, unknown versions do not', () => {
        expect(resolveLatestModel(null, 'claude', { kind: 'machine', cliVersion: '0.2.148' }).model).toBeNull();
        expect(resolveLatestModel(null, 'claude', { kind: 'machine', cliVersion: '0.2.149' }).model).toBe('claude-opus-5-5');
        expect(resolveLatestModel(null, 'claude', { kind: 'machine' }).model).toBe('claude-opus-5-5');
        expect(resolveLatestModel(null, 'claude', { kind: 'none' }).model).toBe('claude-opus-5-5');
    });
});

describe('resolveLatestModel — codex', () => {
    it('Codex 0.166 catalog → gpt-6.1-sol', () => {
        expect(resolveLatestModel(null, 'codex', { kind: 'session', catalog: CODEX_166 })).toMatchObject({ model: 'gpt-6.1-sol', limited: false });
    });

    it('Codex 0.154 catalog lacks gpt-6.x-sol → newest sol it lists (no 400)', () => {
        expect(resolveLatestModel(null, 'codex', { kind: 'session', catalog: CODEX_154 })).toMatchObject({ model: 'gpt-5.6-sol', newest: 'gpt-6.1-sol', limited: true });
    });

    it('a session without a catalog proves nothing → machine default', () => {
        expect(resolveLatestModel(null, 'codex', { kind: 'session', catalog: [] }).model).toBeNull();
    });

    it('machine context gates by the installed Codex version', () => {
        expect(resolveLatestModel(null, 'codex', { kind: 'machine', agentVersion: '0.154.0' }).model).toBe('gpt-5.6-sol');
        expect(resolveLatestModel(null, 'codex', { kind: 'machine', agentVersion: '0.158.0' }).model).toBe('gpt-6-sol');
        expect(resolveLatestModel(null, 'codex', { kind: 'machine', agentVersion: '0.166.0' }).model).toBe('gpt-6.1-sol');
    });
});

describe('resolveLatestModel — gemini', () => {
    it('picks the newest pro from the session catalog, else machine default', () => {
        const catalog = [{ code: 'gemini-2.5-pro' }, { code: 'gemini-3.1-pro-preview' }, { code: 'gemini-3-flash-preview' }];
        expect(resolveLatestModel(null, 'gemini', { kind: 'session', catalog }).model).toBe('gemini-3.1-pro-preview');
        expect(resolveLatestModel(null, 'gemini', { kind: 'session', catalog: [] }).model).toBeNull();
        expect(resolveLatestModel(null, 'gemini', { kind: 'none' }).model).toBe('gemini-3.1-pro-preview');
    });

    it('agents without a tier never resolve', () => {
        expect(resolveLatestModel(null, 'pi', { kind: 'none' }).model).toBeNull();
    });
});

describe('isResolvedLatestModel', () => {
    it('matches only the id latest resolves to in that context', () => {
        const ctx = { kind: 'session' as const, capabilities: [CLAUDE_OPUS_55_CAPABILITY] };
        expect(isResolvedLatestModel(null, 'claude', ctx, 'claude-opus-5-5')).toBe(true);
        expect(isResolvedLatestModel(null, 'claude', ctx, 'claude-opus-5-5[1m]')).toBe(false);
        expect(isResolvedLatestModel(null, 'claude', ctx, 'opus')).toBe(false);
        expect(isResolvedLatestModel(null, 'codex', { kind: 'session', catalog: CODEX_154 }, 'gpt-5.6-sol')).toBe(true);
        expect(isResolvedLatestModel(null, 'codex', { kind: 'session', catalog: CODEX_166 }, 'gpt-5.6-sol')).toBe(false);
    });
});

describe('parseLatestModelTable', () => {
    it('accepts the bundled table and rejects bad shapes / regexes', () => {
        expect(parseLatestModelTable(BUNDLED_LATEST_MODELS)).toEqual(BUNDLED_LATEST_MODELS);
        expect(parseLatestModelTable({ version: 1 })).toBeNull();
        expect(parseLatestModelTable({ version: 1, agents: { claude: { tier: 'opus', pattern: '(', models: [] } } })).toBeNull();
    });

    it('a broken server tier falls back to the bundled one at resolve time', () => {
        const table = { version: 9, agents: { codex: { tier: 'sol', pattern: '(', models: [] } } } as LatestModelTable;
        expect(resolveLatestModel(table, 'codex', { kind: 'none' }).model).toBe('gpt-6.1-sol');
    });
});
