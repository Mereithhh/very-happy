import { describe, expect, it } from 'vitest';
import { resolveMessageModeMeta } from './messageMeta';
import { resolveLatestForAgent } from './agentDefaults';
import { followLatestState } from './followLatestDisplay';

/**
 * B-971: a model written in the machine's Codex config.toml is what a new Web
 * session runs and what its picker shows, unless the user picked one
 * explicitly (this session, or as the account's new-session default) or an
 * account brings its own. The wrapper reports the config's model as
 * `metadata.configuredModel` (string = pinned, null = nothing pinned, absent =
 * an older wrapper that cannot tell); `model: undefined` in the message meta
 * means "send nothing" — Codex then runs its own config.
 */
const catalog = [
    { code: 'gpt-6.2-sol', value: 'GPT-6.2-Sol', reasoningEfforts: ['low', 'medium', 'high'], defaultReasoningEffort: 'medium' },
    { code: 'gpt-6.1-terra', value: 'GPT-6.1-Terra', reasoningEfforts: ['low', 'medium', 'high'], defaultReasoningEffort: 'medium' },
];

function codexSession(metadata: Record<string, unknown>, modelMode: string | null = null) {
    return {
        permissionMode: null,
        modelMode,
        effortLevel: null,
        metadata: { flavor: 'codex', models: catalog, stickyModel: null, ...metadata },
    } as any;
}

describe('B-971 Codex config.toml model on a new Web session', () => {
    it('config pins a model the catalog does not list → nothing is sent (Codex runs the config)', () => {
        const meta = resolveMessageModeMeta(codexSession({ configuredModel: 'deepseek-v4-flash' }));
        expect(meta.model).toBeUndefined();
        expect(meta.modelIntent).toBe('latest');
    });

    it('config pins nothing → follow latest sends the newest catalog model', () => {
        const meta = resolveMessageModeMeta(codexSession({ configuredModel: null }));
        expect(meta.model).toBe('gpt-6.2-sol');
        expect(meta.modelIntent).toBe('latest');
    });

    it('profile-only model: config/read reports nothing pinned (Codex itself applies a profile only with --profile) → same as no model', () => {
        // `[profiles.ds] model = …` / `ds.config.toml` without `--profile ds`:
        // Codex's effective config has no model, so the wrapper reports null.
        const meta = resolveMessageModeMeta(codexSession({ configuredModel: null }));
        expect(meta.model).toBe('gpt-6.2-sol');
    });

    it('an older wrapper that cannot read the config (absent) sends nothing either', () => {
        const meta = resolveMessageModeMeta(codexSession({}));
        expect(meta.model).toBeUndefined();
    });

    it('an explicit pick in this session wins over the config', () => {
        const meta = resolveMessageModeMeta(codexSession({ configuredModel: 'deepseek-v4-flash' }, 'gpt-6.1-terra'));
        expect(meta.model).toBe('gpt-6.1-terra');
        expect(meta.modelIntent).toBe('gpt-6.1-terra');
    });

    it('an account default pinned to a model (「设为新会话默认」) wins over the config', () => {
        const meta = resolveMessageModeMeta(codexSession({ configuredModel: 'deepseek-v4-flash' }), { agentDefaultOverrides: { codex: { modelMode: 'gpt-6.1-terra' } } } as any);
        expect(meta.model).toBe('gpt-6.1-terra');
    });

    it('an account default of 「跟随最新」 still defers to the config', () => {
        const meta = resolveMessageModeMeta(codexSession({ configuredModel: 'deepseek-v4-flash' }), { agentDefaultOverrides: { codex: { modelMode: 'latest' } } } as any);
        expect(meta.model).toBeUndefined();
    });

    it('a session that explicitly picked 「跟随最新」 still defers to the config', () => {
        const meta = resolveMessageModeMeta(codexSession({ configuredModel: 'deepseek-v4-flash' }, 'latest'));
        expect(meta.model).toBeUndefined();
        expect(meta.modelIntent).toBe('latest');
    });

    it('a Codex account publishes its own model as configuredModel → nothing is sent, the wrapper starts the thread on it', () => {
        // runCodex: on an account `configuredModel` = codexAccountDefaultModel (binding pin > account models[0] > config).
        const meta = resolveMessageModeMeta(codexSession({ configuredModel: 'acct-model', models: [{ code: 'acct-model', value: 'acct-model' }] }));
        expect(meta.model).toBeUndefined();
    });

    it('picker: the follow entry names the config model (「本机配置 · deepseek-v4-flash」), not a catalog model', () => {
        const session = resolveLatestForAgent(null, 'codex', codexSession({ configuredModel: 'deepseek-v4-flash' }).metadata);
        expect(followLatestState(session, true)).toEqual({ kind: 'machineConfig', model: 'deepseek-v4-flash' });
        // New-session draft: the machine context comes from that machine's latest session.
        const draft = resolveLatestForAgent(null, 'codex', null, { catalog, configuredModel: 'deepseek-v4-flash' });
        expect(followLatestState(draft, false)).toEqual({ kind: 'machineConfig', model: 'deepseek-v4-flash' });
        // Nothing pinned → the newest catalog model.
        const none = resolveLatestForAgent(null, 'codex', codexSession({ configuredModel: null }).metadata);
        expect(followLatestState(none, true)).toMatchObject({ kind: 'latest', model: 'gpt-6.2-sol' });
    });
});

describe('B-971 codexModelSource (who chose the model the picker shows)', async () => {
    const { codexModelSource } = await import('./codexModelSource');
    const base = { flavor: 'codex', explicitModelMode: null, defaultModelMode: undefined, configuredModel: 'deepseek-v4-flash', onAccount: false };

    it('no pick, no pinned default → the machine config', () => {
        expect(codexModelSource(base)).toEqual({ kind: 'config', model: 'deepseek-v4-flash' });
        expect(codexModelSource({ ...base, defaultModelMode: 'latest' })).toEqual({ kind: 'config', model: 'deepseek-v4-flash' });
        expect(codexModelSource({ ...base, explicitModelMode: 'latest', defaultModelMode: 'gpt-6.1-terra' })).toEqual({ kind: 'config', model: 'deepseek-v4-flash' });
    });

    it('config pins nothing → follow latest', () => {
        expect(codexModelSource({ ...base, configuredModel: null })).toEqual({ kind: 'latest' });
    });

    it('a pinned new-session default names the config model it overrides', () => {
        expect(codexModelSource({ ...base, defaultModelMode: 'gpt-6.1-terra' })).toEqual({ kind: 'newSessionDefault', model: 'gpt-6.1-terra', overriddenConfig: 'deepseek-v4-flash' });
        expect(codexModelSource({ ...base, defaultModelMode: 'deepseek-v4-flash' })).toEqual({ kind: 'newSessionDefault', model: 'deepseek-v4-flash', overriddenConfig: null });
        expect(codexModelSource({ ...base, configuredModel: null, defaultModelMode: 'gpt-6.1-terra' })).toEqual({ kind: 'newSessionDefault', model: 'gpt-6.1-terra', overriddenConfig: null });
    });

    it('an explicit pick in this session is its own (no override note)', () => {
        expect(codexModelSource({ ...base, explicitModelMode: 'gpt-6.1-terra', defaultModelMode: 'gpt-6.2-sol' })).toEqual({ kind: 'session' });
    });

    it('on an account the reported model is the account\'s — never called an override of the config', () => {
        expect(codexModelSource({ ...base, onAccount: true })).toEqual({ kind: 'account' });
        expect(codexModelSource({ ...base, onAccount: true, defaultModelMode: 'gpt-6.1-terra' })).toEqual({ kind: 'newSessionDefault', model: 'gpt-6.1-terra', overriddenConfig: null });
    });

    it('other agents: no source', () => {
        expect(codexModelSource({ ...base, flavor: 'claude' })).toEqual({ kind: 'none' });
    });
});
