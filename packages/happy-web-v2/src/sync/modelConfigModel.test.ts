import { describe, expect, it, vi } from 'vitest';
import { formFromView, newProviderForm, harnessForFlavor, machineSupportsModelConfig, patchFromForm, splitModelList, withCustomModels, describeModelConfigError, parseContextWindow, parsePiModelLines, piModelLinesError } from './modelConfigModel';
import { createModelConfigStore } from './modelConfigStore';
import type { HarnessConfigView } from './modelConfigTypes';

const view = (over: Partial<HarnessConfigView> & Pick<HarnessConfigView, 'harness'>): HarnessConfigView => ({
    installed: true, files: [], baseHash: 'h', current: {}, pickerModels: [], backups: [], warnings: [], ...over,
});

describe('capability + harness mapping', () => {
    it('gates on machine metadata modelConfigVersion (old CLIs lack it)', () => {
        expect(machineSupportsModelConfig({ metadata: { modelConfigVersion: 1 } })).toBe(true);
        expect(machineSupportsModelConfig({ metadata: {} })).toBe(false);
        expect(machineSupportsModelConfig(null)).toBe(false);
    });
    it('maps session flavors to harnesses; pi sessions report flavor acp; others are not configurable', () => {
        expect(harnessForFlavor(undefined)).toBe('claude');
        expect(harnessForFlavor('codex')).toBe('codex');
        expect(harnessForFlavor('acp')).toBe('pi');
        expect(harnessForFlavor('gemini')).toBe('gemini');
        expect(harnessForFlavor('opencode')).toBeNull();
        expect(harnessForFlavor('openclaw')).toBeNull();
    });
});

describe('withCustomModels', () => {
    it('appends only unseen keys, after the session list', () => {
        const base = [{ key: 'default', name: 'default model' }, { key: 'opus', name: 'opus' }];
        expect(withCustomModels(base, ['opus', 'glm-5.3'], 'custom').map((o) => o.key)).toEqual(['default', 'opus', 'glm-5.3']);
        expect(withCustomModels(base, [], 'custom')).toBe(base);
    });
});

describe('patchFromForm', () => {
    it('sends only what changed — an untouched form is an empty patch', () => {
        const v = view({ harness: 'claude', current: { baseUrl: 'https://gw', model: 'glm', apiKey: { mode: 'literal', masked: 'sk-a…zzzz' }, authHeader: 'bearer', pickerModels: ['a'] } });
        const form = formFromView('claude', v);
        expect(patchFromForm(form, v)).toEqual({ harness: 'claude' });
        expect(patchFromForm({ ...form, baseUrl: '', model: 'kimi', keyMode: 'env', keyEnv: 'GW_KEY', extraModels: 'a\nb' }, v))
            .toEqual({ harness: 'claude', baseUrl: null, model: 'kimi', apiKey: { mode: 'env', name: 'GW_KEY' }, pickerModels: ['a', 'b'] });
    });
    it('never sends an empty literal key (keep instead)', () => {
        const form = formFromView('claude', null);
        expect(patchFromForm({ ...form, keyMode: 'literal', keyValue: '  ' }, null)).toEqual({ harness: 'claude' });
    });
    it('new codex provider carries base URL and activation', () => {
        const form = { ...formFromView('codex', null), providerId: 'mock', baseUrl: 'http://127.0.0.1:5341/v1', model: 'm', keyMode: 'literal' as const, keyValue: 'sk-x' };
        expect(form.isNewProvider).toBe(true);
        expect(patchFromForm(form, null)).toEqual({ harness: 'codex', providerId: 'mock', baseUrl: 'http://127.0.0.1:5341/v1', apiKey: { mode: 'literal', value: 'sk-x' }, model: 'm', activate: true });
    });
    it('a new codex provider keeps the top-level model (it is not per provider)', () => {
        const v = view({ harness: 'codex', current: { providerId: 'old', baseUrl: 'https://o/v1', model: 'gpt-5.5', active: true } });
        const form = { ...newProviderForm('codex', true, v), providerId: 'new', baseUrl: 'https://n/v1' };
        expect(form.model).toBe('gpt-5.5');
        expect(patchFromForm(form, v)).toEqual({ harness: 'codex', providerId: 'new', baseUrl: 'https://n/v1', activate: true });
    });
    it('pi: models list and default model when activating', () => {
        const v = view({ harness: 'pi', current: { providerId: 'gw', baseUrl: 'https://x/v1', api: 'openai-completions', models: ['a'], active: false } });
        const form = formFromView('pi', v);
        expect(patchFromForm({ ...form, extraModels: 'a, b', activate: true, model: 'b' }, v)).toEqual({ harness: 'pi', providerId: 'gw', models: ['a', 'b'], activate: true, defaultModel: 'b' });
    });
});

describe('splitModelList', () => {
    it('accepts newlines and commas, dedupes', () => expect(splitModelList(' a,\nb\n\na ')).toEqual(['a', 'b']));
});

describe('describeModelConfigError', () => {
    it('old daemon → unsupported; stale preview → conflict', () => {
        expect(describeModelConfigError({ error: 'Method not found', unsupported: true }).kind).toBe('unsupported');
        expect(describeModelConfigError({ error: 'x', code: 'conflict', unsupported: false }).kind).toBe('conflict');
        expect(describeModelConfigError({ error: 'x', code: 'json-has-comments', unsupported: false }).kind).toBe('invalid');
    });
});

describe('modelConfigStore', () => {
    it('dedupes loads, honours the TTL, and setHarnessView updates picker models at once', async () => {
        let now = 0;
        const read = vi.fn(async () => ({ ok: true as const, data: { version: 1, harnesses: [view({ harness: 'codex', pickerModels: ['old'] })] } }));
        const store = createModelConfigStore({ read, now: () => now, ttlMs: 1000 });
        await Promise.all([store.getState().load('m1'), store.getState().load('m1')]);
        expect(read).toHaveBeenCalledTimes(1);
        now = 500;
        await store.getState().load('m1');
        expect(read).toHaveBeenCalledTimes(1);
        await store.getState().load('m1', { force: true });
        expect(read).toHaveBeenCalledTimes(2);
        store.getState().setHarnessView('m1', view({ harness: 'codex', pickerModels: ['mock-model'] }));
        expect(store.getState().machines.m1.data?.harnesses[0].pickerModels).toEqual(['mock-model']);
    });
    it('keeps the last data when a reload fails and marks unsupported', async () => {
        const results = [
            { ok: true as const, data: { version: 1, harnesses: [view({ harness: 'claude' })] } },
            { ok: false as const, error: 'Method not found', unsupported: true },
        ];
        const store = createModelConfigStore({ read: async () => results.shift()!, now: () => 0 });
        await store.getState().load('m');
        await store.getState().load('m', { force: true });
        const state = store.getState().machines.m;
        expect(state.status).toBe('error');
        expect(state.status === 'error' && state.unsupported).toBe(true);
        expect(state.data?.harnesses).toHaveLength(1);
    });
});

describe('pi context windows in the model list (B-727)', () => {
    it('parses sizes with k / M suffixes; rejects junk', () => {
        expect(parseContextWindow('200k')).toBe(200_000);
        expect(parseContextWindow('1M')).toBe(1_000_000);
        expect(parseContextWindow('1.5m')).toBe(1_500_000);
        expect(parseContextWindow('262144')).toBe(262_144);
        expect(parseContextWindow('big')).toBeNull();
        expect(parseContextWindow('0')).toBeNull();
    });
    it('reads `id` and `id <size>` lines', () => {
        expect(parsePiModelLines('glm-5.3 200k\nkimi-k3, deepseek 1M')).toEqual({ ids: ['glm-5.3', 'kimi-k3', 'deepseek'], windows: { 'glm-5.3': 200_000, deepseek: 1_000_000 }, invalid: null });
        expect(parsePiModelLines('glm-5.3 huge').invalid).toBe('glm-5.3 huge');
    });
    it('round-trips the view: an untouched form sends no contextWindows', () => {
        const v = view({ harness: 'pi', current: { providerId: 'gw', baseUrl: 'https://x/v1', api: 'openai-completions', models: ['a', 'b'], contextWindows: { a: 1_000_000 }, active: true } });
        const form = formFromView('pi', v);
        expect(form.extraModels).toBe('a 1M\nb');
        expect(patchFromForm(form, v)).toEqual({ harness: 'pi', providerId: 'gw' });
        // set b, drop a's window (pi then assumes 128k again)
        expect(patchFromForm({ ...form, extraModels: 'a\nb 262144' }, v)).toEqual({ harness: 'pi', providerId: 'gw', contextWindows: { a: null, b: 262_144 } });
    });
    it('never sends windows to a daemon that does not report them', () => {
        const old = view({ harness: 'pi', current: { providerId: 'gw', baseUrl: 'https://x/v1', models: ['a'] } });
        const form = { ...formFromView('pi', old), extraModels: 'a 200k' };
        expect(patchFromForm(form, old)).toEqual({ harness: 'pi', providerId: 'gw', api: 'openai-completions' });
        expect(piModelLinesError(form, old)).toEqual({ code: 'needs-upgrade' });
        expect(piModelLinesError({ ...form, extraModels: 'a' }, old)).toBeNull();
        expect(piModelLinesError({ ...form, extraModels: 'a lots' }, old)).toEqual({ code: 'invalid-line', line: 'a lots' });
    });
});
