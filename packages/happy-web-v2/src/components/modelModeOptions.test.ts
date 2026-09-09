import { describe, expect, it } from 'vitest';
import {
    compactResolvedModelCode,
    getAvailableModels,
    getAvailablePermissionModes,
    getClaudeModelModes,
    getDefaultEffortKey,
    getDefaultModelKey,
    getDefaultPermissionModeKey,
    getEffortLevelsForModel,
    getHardcodedModelModes,
    getHardcodedPermissionModes,
    relabelDefaultModel,
} from './modelModeOptions';

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
    it('mirrors the Claude Code 2.1.258 /model aliases with their current labels', () => {
        const modes = getClaudeModelModes();
        const byKey = Object.fromEntries(modes.map((m) => [m.key, m.name]));
        expect(byKey).toMatchObject({
            default: 'default model',
            fable: 'fable 5.1',
            'fable[1m]': 'fable 5.1 (1M context)',
            opus: 'opus 5',
            'opus[1m]': 'opus 5 (1M context)',
            sonnet: 'sonnet 5',
            'sonnet[1m]': 'sonnet 5 (1M context)',
            haiku: 'haiku 4.5',
            opusplan: 'opus plan',
            best: 'best available',
        });
        // fable5 is rejected by Claude Code 2.1.258 (unrecognized_model) — never offer it.
        expect(modes.some((m) => m.key === 'fable5')).toBe(false);
        expect(modes[0].key).toBe('default');
        expect(modes[1].key).toBe('fable');
        // Every key must survive the daemon's resume-model charset (letters, digits, . _ : - and a trailing [1m]).
        for (const m of modes) expect(m.key).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}(\[1m\])?$/);
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
