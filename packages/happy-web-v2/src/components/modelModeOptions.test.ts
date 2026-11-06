import { describe, expect, it } from 'vitest';
import {
    compactResolvedModelCode,
    getAvailableModels,
    getAvailablePermissionModes,
    getClaudeModelModes,
    getCodexModelModes,
    getDefaultEffortKey,
    getDefaultModelKey,
    getDefaultPermissionModeKey,
    getEffortLevelsForModel,
    getHardcodedModelModes,
    getHardcodedPermissionModes,
    relabelDefaultModel, codexModelGate, withClaudeCatalogBases, catalogRunnableKeys } from './modelModeOptions';

describe('resolved default model labels', () => {
    it('keeps the concrete model value while removing the redundant Claude prefix', () => {
        expect(compactResolvedModelCode('claude-opus-5[1m]')).toBe('opus-5[1m]');
        expect(compactResolvedModelCode('gpt-5.5')).toBe('gpt-5.5');
    });

    it('only relabels the default option', () => {
        expect(relabelDefaultModel([
            { key: 'default', name: 'default model' },
            { key: 'opus', name: 'opus 5' },
        ], 'opus-5 (default)')).toEqual([
            { key: 'default', name: 'opus-5 (default)' },
            { key: 'opus', name: 'opus 5' },
        ]);
    });
});

describe('Claude model picker (Fable 5.1)', () => {
    it('mirrors the bundled Claude Code 2.1.318 /model aliases and pins Opus 5.5 and Fable 5.1', () => {
        const modes = getClaudeModelModes();
        const byKey = Object.fromEntries(modes.map((m) => [m.key, m.name]));
        expect(byKey).toMatchObject({
            default: 'default model',
            'claude-fable-5-1': 'Fable 5.1',
            'claude-fable-5-1[1m]': 'Fable 5.1 · 1M',
            fable: 'fable (alias)',
            'fable[1m]': 'fable (alias) · 1M',
            'claude-opus-5-5': 'Opus 5.5',
            'claude-opus-5-5[1m]': 'Opus 5.5 · 1M',
            opus: 'opus (alias)',
            'opus[1m]': 'opus (alias) · 1M',
            sonnet: 'Sonnet 5.5',
            'sonnet[1m]': 'Sonnet 5.5 · 1M',
            haiku: 'Haiku 5.5',
            opusplan: 'opusplan',
            best: 'best',
        });
        // fable5 is rejected by Claude Code 2.1.258 (unrecognized_model) — never offer it.
        expect(modes.some((m) => m.key === 'fable5')).toBe(false);
        expect(modes[0].key).toBe('default');
        expect(modes[1].key).toBe('claude-opus-5-5');
        // B-844: the code default is the follow-latest sentinel, resolved at send time.
        expect(getDefaultModelKey('claude')).toBe('latest');
        // Every key must survive the daemon's resume-model charset (letters, digits, . _ : - and a trailing [1m]).
        for (const m of modes) expect(m.key).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}(\[1m\])?$/);
    });

    it('adds pinned Opus 5.5 to a session catalog only when the wrapper can run it', () => {
        const t = (k: string) => k;
        // Catalog shape SDK 0.3.281 publishes: Opus 5.5 only under the opus alias.
        const models = [
            { code: 'default', value: 'Default (recommended)', resolvedModel: 'claude-opus-5-5' },
            { code: 'opus', value: 'Opus 5.5', resolvedModel: 'claude-opus-5-5' },
        ];
        expect(getAvailableModels('claude', { models, capabilities: ['claude-opus-5-5-v1'] } as any, t as any).map((m) => m.key))
            .toEqual(['default', 'claude-opus-5-5', 'claude-opus-5-5[1m]', 'opus']);
        expect(getAvailableModels('claude', { models, capabilities: ['claude-steer-v1'] } as any, t as any).map((m) => m.key))
            .toEqual(['default', 'opus']);
    });

    it('names the SDK opus alias apart from pinned Opus 5.5 without dropping it', () => {
        const t = (k: string) => k;
        const models = [
            { code: 'default', value: 'Default (recommended)', resolvedModel: 'claude-opus-5-5' },
            { code: 'opus', value: 'Opus 5.5', resolvedModel: 'claude-opus-5-5' },
            { code: 'opus[1m]', value: 'Opus 5.5 (1M context)', resolvedModel: 'claude-opus-5-5[1m]' },
            { code: 'sonnet', value: 'Sonnet 5', resolvedModel: 'claude-sonnet-5' },
        ];
        const names = Object.fromEntries(getAvailableModels('claude', { models, capabilities: ['claude-opus-5-5-v1'] } as any, t as any).map((m) => [m.key, m.name]));
        expect(names).toMatchObject({
            'claude-opus-5-5': 'Opus 5.5',
            opus: 'opus (alias)',
            'opus[1m]': 'opus (alias, 1M context)',
            sonnet: 'Sonnet 5',
            default: 'Default (recommended)',
        });
        // Without pinned entries there is nothing to tell apart: SDK names stay.
        const plain = getAvailableModels('claude', { models } as any, t as any);
        expect(plain.find((m) => m.key === 'opus')?.name).toBe('Opus 5.5');
    });

    it('is what Settings → Agents shows for claude', () => {
        expect(getHardcodedModelModes('claude', (k) => k)).toEqual(getClaudeModelModes());
    });
});

describe('pi pickers (B-370)', () => {
    const t = (k: string) => k;
    const piMetadata = {
        // Real shape published by pi-acp 0.0.33 (probed on 23 sessions 2026-09-07):
        // models = pi's registry; operatingModes = THINKING levels, not permissions.
        models: [
            { code: 'zai/glm-5.3', value: 'zai/GLM-5.3' },
            { code: 'llm-hub/claude-fable-5-1', value: 'llm-hub/Claude Fable 5.1 (llm-hub)' },
        ],
        currentModelCode: 'llm-hub/claude-fable-5-1',
        operatingModes: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'].map((code) => ({ code, value: `Thinking: ${code}` })),
        currentOperatingModeCode: 'medium',
    } as any;

    it("never offers Claude aliases for pi — hardcoded list is just 'default' (follow the machine's pi)", () => {
        for (const flavor of ['pi', 'acp']) {
            const modes = getHardcodedModelModes(flavor, t as any);
            expect(modes.map((m) => m.key)).toEqual(['default']);
            expect(modes.some((m) => ['opus', 'sonnet', 'fable'].includes(m.key))).toBe(false);
        }
        // claude is unchanged
        expect(getHardcodedModelModes('claude', t as any)).toEqual(getClaudeModelModes());
    });

    it('in a session the model list is what pi-acp published', () => {
        expect(getAvailableModels('acp', piMetadata, t as any).map((m) => m.key))
            .toEqual(['zai/glm-5.3', 'llm-hub/claude-fable-5-1']);
    });

    it('permission picker is the two modes the pi gate distinguishes, never the thinking levels', () => {
        for (const flavor of ['pi', 'acp']) {
            expect(getAvailablePermissionModes(flavor, piMetadata, t as any).map((m) => m.key))
                .toEqual(['default', 'bypassPermissions']);
            expect(getHardcodedPermissionModes(flavor, t as any).map((m) => m.key))
                .toEqual(['default', 'bypassPermissions']);
        }
        // gemini (also an ACP runner) still reads its published operating modes
        expect(getAvailablePermissionModes('gemini', piMetadata, t as any).map((m) => m.key)).toContain('medium');
        // claude untouched
        expect(getAvailablePermissionModes('claude', piMetadata, t as any).map((m) => m.key))
            .toEqual(['default', 'plan', 'acceptEdits', 'bypassPermissions']);
    });

    it('pi code defaults come from its own slot and it exposes no effort picker', () => {
        expect(getDefaultModelKey('acp')).toBe('default');
        expect(getDefaultPermissionModeKey('acp')).toBe('bypassPermissions');
        expect(getDefaultEffortKey('acp')).toBeNull();
        expect(getEffortLevelsForModel('acp', 'llm-hub/claude-fable-5-1')).toEqual([]);
    });
});


describe('model-specific reasoning catalogs', () => {
    it('uses each app-server model exact levels, including ultra only when advertised', () => {
        const metadata = { defaultModelCode: 'gpt-5.6-sol', models: [
            { code: 'gpt-5.6-sol', value: 'Sol', reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
            { code: 'gpt-5.6-luna', value: 'Luna', reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
            { code: 'no-reasoning', value: 'Plain', reasoningEfforts: [] },
        ] } as any;
        expect(getEffortLevelsForModel('codex', 'default', metadata).map(x => x.key)).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
        expect(getEffortLevelsForModel('codex', 'gpt-5.6-luna', metadata).map(x => x.key)).not.toContain('ultra');
        expect(getEffortLevelsForModel('codex', 'no-reasoning', metadata)).toEqual([]);
        expect(getEffortLevelsForModel('codex', 'gpt-6-astra').map(x => x.key)).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
        // gpt-6-sol/luna are missing from Codex 0.154's catalog; a wrapper that
        // published one still gets their fallback range.
        expect(getEffortLevelsForModel('codex', 'gpt-6-sol', metadata).map(x => x.key)).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
        expect(getEffortLevelsForModel('codex', 'gpt-6-luna', metadata).map(x => x.key)).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    });
    it('B-893: offers the whole gpt-6 generation even when the Codex catalog lacks it', () => {
        const t = (k: string) => k;
        // Codex 0.154's model/list (dev-sg, 2026-11-06): astra and 5.6-* only.
        const metadata = { models: [{ code: 'gpt-6-astra', value: 'GPT-6-Astra' }, { code: 'gpt-5.6-sol', value: 'GPT-5.6-Sol' }, { code: 'gpt-5.5', value: 'GPT-5.5' }] } as any;
        expect(getAvailableModels('codex', metadata, t as any).map((m) => m.key))
            .toEqual(['default', 'gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.5']);
        // A model this Codex does not bundle still runs (0.154 on llm-hub ran them all): never disabled.
        expect(getAvailableModels('codex', metadata, t as any).filter((m) => m.disabled)).toEqual([]);
        expect(getCodexModelModes().map((m) => m.key).slice(1, 6)).toEqual(['gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna']);
    });
    it('B-893: marks a gpt-6 model this machine\'s Codex does not bundle, never one it does', () => {
        const catalog154 = new Set(['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.5']);
        expect(codexModelGate('gpt-6.1-sol', { catalogCodes: catalog154, agentVersion: '0.154.0' })).toEqual({ since: '0.160.0' });
        expect(codexModelGate('gpt-6.1-terra', { catalogCodes: catalog154, agentVersion: '0.154.0' })).toEqual({ since: '0.165.0' });
        expect(codexModelGate('gpt-6-sol', { catalogCodes: catalog154, agentVersion: '0.154.0' })).toEqual({ since: '0.157.0' });
        // astra is in every catalog since 0.154; listed models and new-enough Codex are never marked.
        expect(codexModelGate('gpt-6-astra', { catalogCodes: catalog154, agentVersion: '0.154.0' })).toBeNull();
        expect(codexModelGate('gpt-6-sol', { catalogCodes: new Set(['gpt-6-sol']), agentVersion: '0.154.0' })).toBeNull();
        expect(codexModelGate('gpt-6.1-terra', { catalogCodes: catalog154, agentVersion: '0.167.0' })).toBeNull();
        // Version unknown: the catalog decides; neither known → nothing to say.
        expect(codexModelGate('gpt-6-sol', { catalogCodes: catalog154 })).toEqual({ since: '0.157.0' });
        expect(codexModelGate('gpt-6-sol', {})).toBeNull();
        // No catalog yet (new-session dialog): the installed version decides.
        expect(codexModelGate('gpt-6.1-sol', { agentVersion: '0.157.2' })).toEqual({ since: '0.160.0' });
        expect(codexModelGate('gpt-6.1-sol', { agentVersion: 'v0.160.0' })).toBeNull();
    });
    it('B-893: a [1m]-only Claude catalog entry (Fable, CC 2.1.30x+) gets its plain id, both named by version', () => {
        const t = (k: string) => k;
        // SDK 0.3.318 supportedModels() on dev-sg, 2026-11-06.
        const metadata = { models: [
            { code: 'default', value: 'Default (recommended)', resolvedModel: 'claude-opus-5-5' },
            { code: 'opus', value: 'Opus 5.5', resolvedModel: 'claude-opus-5-5' },
            { code: 'claude-fable-5-1[1m]', value: 'Fable', resolvedModel: 'claude-fable-5-1' },
            { code: 'sonnet', value: 'Sonnet 5', resolvedModel: 'claude-sonnet-5' },
        ] } as any;
        const keysAndNames = getAvailableModels('claude', metadata, t as any).map((m) => `${m.key}=${m.name}`);
        expect(keysAndNames).toEqual(expect.arrayContaining(['claude-fable-5-1=Fable 5.1', 'claude-fable-5-1[1m]=Fable 5.1 · 1M']));
        expect(keysAndNames.indexOf('claude-fable-5-1=Fable 5.1')).toBe(keysAndNames.indexOf('claude-fable-5-1[1m]=Fable 5.1 · 1M') - 1);
        expect(withClaudeCatalogBases([{ key: 'x[1m]', name: 'x' }])).toEqual([{ key: 'x[1m]', name: 'x' }]);
        // A session already on claude-fable-5-1: CC lists that id, still named 「Fable」.
        expect(withClaudeCatalogBases([{ key: 'claude-fable-5-1', name: 'Fable' }, { key: 'claude-opus-5-5', name: 'Opus 5.5 (custom)' }]))
            .toEqual([{ key: 'claude-fable-5-1', name: 'Fable 5.1' }, { key: 'claude-opus-5-5', name: 'Opus 5.5 (custom)' }]);
        expect([...catalogRunnableKeys('claude', ['claude-fable-5-1[1m]'])]).toEqual(['claude-fable-5-1[1m]', 'claude-fable-5-1', 'claude-opus-5-5']);
    });
    it('uses ACP thought levels independently of permissions, including legacy pi levels', () => {
        const thoughtLevels = [{ code: 'off', value: 'Off' }, { code: 'custom', value: 'Deep' }];
        expect(getEffortLevelsForModel('opencode', 'default', { thoughtLevels } as any).map(x => x.key)).toEqual(['off', 'custom']);
        expect(getEffortLevelsForModel('acp', 'default', { operatingModes: thoughtLevels } as any).map(x => x.key)).toEqual(['off', 'custom']);
    });
});


it('keeps older Codex wrappers on their supported four levels', () => {
    expect(getEffortLevelsForModel('codex', 'gpt-6-astra', {} as any).map(x => x.key)).toEqual(['low', 'medium', 'high', 'xhigh']);
});
it('honors Claude per-model SDK capabilities and does not invent Haiku effort', () => {
    expect(getEffortLevelsForModel('claude', 'haiku')).toEqual([]);
    expect(getEffortLevelsForModel('claude', 'sonnet', { models: [{ code: 'sonnet', value: 'Sonnet', reasoningEfforts: ['low', 'high'] }] } as any).map(x => x.key)).toEqual(['low', 'high']);
});


it('hides the previous ACP model thinking catalog while a new model is selected', () => {
    const metadata = { currentModelCode: 'deep', thoughtLevels: [{ code: 'xhigh', value: 'Extra high' }] } as any;
    expect(getEffortLevelsForModel('acp', 'small', metadata)).toEqual([]);
    expect(getEffortLevelsForModel('acp', 'deep', metadata).map(x => x.key)).toEqual(['xhigh']);
});


describe('permission display vocabulary', () => {
    it('relabels known Gemini CLI modes without adding capabilities or changing keys', () => {
        const metadata = { operatingModes: [
            { code: 'auto_edit', value: 'Auto edit' },
            { code: 'yolo', value: 'YOLO' },
            { code: 'custom-policy', value: 'Company policy', description: 'Managed by host' },
        ] } as any;
        const modes = getAvailablePermissionModes('gemini', metadata, (key) => key);
        expect(modes.map((mode) => mode.key)).toEqual(['auto_edit', 'yolo', 'custom-policy']);
        expect(modes[0].name).toBe('agentInput.geminiPermissionMode.autoEdit');
        expect(modes[1].name).toBe('agentInput.geminiPermissionMode.yolo');
        expect(modes[1].description).toBe('agentInput.permissionMode.autoRunDescription');
        expect(modes[2]).toEqual({ key: 'custom-policy', name: 'Company policy', description: 'Managed by host' });
    });
});
