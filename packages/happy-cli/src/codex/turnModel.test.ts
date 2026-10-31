import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { codexModelFacts, resolveCodexTurnModel } from './turnModel';
import { threadModelOf } from './codexAppServerClient';

describe('resolveCodexTurnModel (B-844c/B-844d)', () => {
    it('an explicit model wins', () => {
        expect(resolveCodexTurnModel({ model: 'gpt-6-luna' }, 'gpt-5.6-sol')).toBe('gpt-6-luna');
    });

    it('an explicit reset (meta.model === null) names the machine default, so a thread pinned by an earlier turn is reset', () => {
        expect(resolveCodexTurnModel({ modelReset: true }, 'gpt-5.6-sol')).toBe('gpt-5.6-sol');
    });

    it('no model and no reset → omitted, so the thread keeps its model (send --resume, after abort)', () => {
        expect(resolveCodexTurnModel({}, 'gpt-5.6-sol')).toBeUndefined();
    });

    it('reset with an unknown machine default → omitted (Codex decides)', () => {
        expect(resolveCodexTurnModel({ modelReset: true }, undefined)).toBeUndefined();
    });
});

describe('codexModelFacts (B-844d)', () => {
    it('a thread on a model the config would not choose is sticky and running', () => {
        expect(codexModelFacts({ threadModel: 'gpt-6-luna', pendingModel: undefined, machineDefault: 'gpt-5.6-sol' }))
            .toEqual({ stickyModel: 'gpt-6-luna', currentModelCode: 'gpt-6-luna' });
    });

    it('a thread on the machine default is not sticky', () => {
        expect(codexModelFacts({ threadModel: 'gpt-5.6-sol', pendingModel: 'gpt-5.6-sol', machineDefault: 'gpt-5.6-sol' }))
            .toEqual({ stickyModel: null, currentModelCode: 'gpt-5.6-sol' });
    });

    it('the thread model wins over a lost/stale in-memory pick', () => {
        expect(codexModelFacts({ threadModel: 'gpt-6-luna', pendingModel: undefined, machineDefault: 'gpt-5.6-sol' }).stickyModel).toBe('gpt-6-luna');
    });

    it('no thread yet → the pending explicit pick, no running model', () => {
        expect(codexModelFacts({ threadModel: null, pendingModel: 'gpt-6-luna', machineDefault: 'gpt-5.6-sol' })).toEqual({ stickyModel: 'gpt-6-luna' });
        expect(codexModelFacts({ threadModel: null, pendingModel: undefined, machineDefault: 'gpt-5.6-sol' })).toEqual({ stickyModel: null });
    });
});

describe('threadModelOf (B-844d)', () => {
    it('reads thread/resume\'s model (Codex 0.166: top-level and thread.model)', () => {
        expect(threadModelOf({ model: 'gpt-6-luna', thread: { id: 't' } })).toBe('gpt-6-luna');
        expect(threadModelOf({ thread: { model: 'gpt-6-luna' } })).toBe('gpt-6-luna');
        expect(threadModelOf({ model: '' })).toBeNull();
        expect(threadModelOf(null)).toBeNull();
    });
});

describe('runCodex wiring (B-844d)', () => {
    const source = readFileSync(new URL('./runCodex.ts', import.meta.url), 'utf8');

    it('only an explicit null marks a reset; a missing model field keeps the sticky pick', () => {
        expect(source).toMatch(/if \(message\.meta\?\.hasOwnProperty\('model'\)\) \{\n\s*messageModel = message\.meta\.model \|\| undefined;\n\s*messageModelReset = !messageModel;/);
        expect(source).toContain('...(messageModelReset ? { modelReset: true } : {}),');
        expect(source).toContain('const turnModel = resolveCodexTurnModel(message.mode, machineDefaultModel);');
    });

    it('sends the resolved model on thread start and on every turn', () => {
        expect(source).toContain('machineDefaultModel = configured?.model ?? discoveredModels.find((model) => model.isDefault)?.model;');
        expect(source).toMatch(/startThread\(\{\n\s*model: turnModel,/);
        expect(source).toMatch(/sendTurnAndWait\([\s\S]{0,300}?model: turnModel,\n\s*approvalPolicy: executionPolicy\.approvalPolicy,\n\s*sandbox: executionPolicy\.sandbox,\n\s*effort: message\.mode\.effort,/);
    });

    it('abort does not forget the model', () => {
        const reset = source.match(/const resetCurrentModeDefaults = \(\) => \{([\s\S]*?)\n    \};/)?.[1] ?? '';
        expect(reset).toContain('currentEffort = DEFAULT_CODEX_EFFORT;');
        expect(reset).not.toMatch(/currentModel\s*=/);
    });

    it('publishes facts from the thread\'s real model, after resume/import, start and every turn', () => {
        expect(source).toContain('codexModelFacts({ threadModel: client.threadModel, pendingModel: currentModel, machineDefault: machineDefaultModel })');
        expect(source).toMatch(/importCodexThreadId,\n\s*cwd: process\.cwd\(\),\n\s*mcpServers,\n\s*\}\);\n\s*first = false;\n\s*appendSystemPromptInjected = true;\n\s*\}\n(\s*\/\/.*\n)*\s*reportModeFacts\(\);/);
        expect(source).toMatch(/codexThreadId: startedThread\.threadId,\n\s*\}\)\);\n\s*reportModeFacts\(\);/);
        expect(source).toMatch(/effort: message\.mode\.effort,\n\s*onTurnStarted: \(\) => heldInput\.delivered\(\),\n\s*\}\);\n\s*reportModeFacts\(\);/);
    });
});
