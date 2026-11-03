import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { liveModelTarget, parseClaudeRunFacts, readClaudeRunFacts } from './claudeRunFacts';
import { applyClaudeRunFacts } from './claudeSdkMetadata';
import type { Metadata } from '@/api/types';

// Shape probed against the pinned SDK 0.3.306 (claudeRunFacts.ts header).
const PROBED = {
    effective: { model: 'claude-haiku-5-5', permissions: {} },
    sources: [],
    applied: { model: 'claude-haiku-5-5', effort: 'medium', advisor: null, ultracode: false },
};

describe('parseClaudeRunFacts (B-849b)', () => {
    it('settings model → configuredModel, applied effort → effort', () => {
        expect(parseClaudeRunFacts(PROBED)).toEqual({ configuredModel: 'claude-haiku-5-5', effort: 'medium' });
    });
    it('nothing pinned is null, not unknown; no effort sent is null', () => {
        expect(parseClaudeRunFacts({ effective: {}, applied: { effort: null } })).toEqual({ configuredModel: null, effort: null });
    });
    it('B-883: ANTHROPIC_MODEL pins too — settings env over the process env over the settings model (probed CC 2.1.306)', () => {
        expect(parseClaudeRunFacts({ effective: { model: 'opus[1m]' } }, 'claude-sonnet-5-5').configuredModel).toBe('claude-sonnet-5-5');
        expect(parseClaudeRunFacts({ effective: { model: 'opus[1m]', env: { ANTHROPIC_MODEL: 'claude-haiku-5-5' } } }, 'claude-sonnet-5-5').configuredModel).toBe('claude-haiku-5-5');
        expect(parseClaudeRunFacts({ effective: {} }, 'claude-opus-5-5[1m]').configuredModel).toBe('claude-opus-5-5[1m]');
        expect(parseClaudeRunFacts({ effective: {} }, '  ').configuredModel).toBeNull();
    });
    it('unknown shapes say nothing', () => {
        expect(parseClaudeRunFacts(null)).toEqual({});
        expect(parseClaudeRunFacts({ applied: { effort: 'ludicrous' } })).toEqual({});
    });
});

describe('readClaudeRunFacts / liveModelTarget', () => {
    // The host running the tests may itself export ANTHROPIC_MODEL.
    beforeEach(() => { vi.stubEnv('ANTHROPIC_MODEL', ''); });
    afterEach(() => { vi.unstubAllEnvs(); });
    const live = (answer: () => Promise<unknown>) => ({ getSettings: answer });
    it('B-883: the inherited ANTHROPIC_MODEL counts as the machine config', async () => {
        vi.stubEnv('ANTHROPIC_MODEL', 'claude-opus-5-5[1m]');
        expect((await readClaudeRunFacts(live(async () => ({ effective: {} }))))?.configuredModel).toBe('claude-opus-5-5[1m]');
    });
    it('reads the live Query', async () => {
        expect(await readClaudeRunFacts(live(async () => PROBED))).toEqual({ configuredModel: 'claude-haiku-5-5', effort: 'medium' });
    });
    it('a Claude Code without get_settings, a rejection or a hang is null — never a throw', async () => {
        expect(await readClaudeRunFacts({})).toBeNull();
        expect(await readClaudeRunFacts(live(async () => { throw new Error('Unsupported control request subtype'); }))).toBeNull();
        expect(await readClaudeRunFacts(live(() => new Promise(() => {})), 10)).toBeNull();
    });
    it('machine default switches to the settings model, not Claude Code\'s built-in default', async () => {
        // REGRESSION (probe 2026-10-31): setModel(undefined) ran Fable 5.1 while
        // settings.local.json pinned Haiku, so 「本机配置」 mid-session lied.
        expect(await liveModelTarget(live(async () => PROBED), undefined)).toBe('claude-haiku-5-5');
        expect(await liveModelTarget(live(async () => PROBED), 'claude-sonnet-5-5')).toBe('claude-sonnet-5-5');
        expect(await liveModelTarget(live(async () => ({ effective: {} })), undefined)).toBeUndefined();
        expect(await liveModelTarget({}, undefined)).toBeUndefined();
    });
});

describe('applyClaudeRunFacts', () => {
    const base = { path: '/w', host: 'h' } as Metadata;
    it('publishes the effort really sent and the settings model', () => {
        expect(applyClaudeRunFacts(base, { effort: 'xhigh', configuredModel: 'opus[1m]' })).toMatchObject({ currentThoughtLevelCode: 'xhigh', configuredModel: 'opus[1m]' });
    });
    it('unchanged facts keep the same object (no metadata write per turn)', () => {
        const current = { ...base, currentThoughtLevelCode: 'high', configuredModel: null };
        expect(applyClaudeRunFacts(current, { effort: 'high', configuredModel: null })).toBe(current);
        expect(applyClaudeRunFacts(current, {})).toBe(current);
    });
    it('no effort sent drops the level instead of showing a stale one', () => {
        const next = applyClaudeRunFacts({ ...base, currentThoughtLevelCode: 'high' }, { effort: null });
        expect('currentThoughtLevelCode' in next).toBe(false);
    });
});
