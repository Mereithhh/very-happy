import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolveCodexTurnModel } from './turnModel';

describe('resolveCodexTurnModel (B-844c)', () => {
    it('an explicit model wins', () => {
        expect(resolveCodexTurnModel('gpt-6-luna', 'gpt-5.6-sol')).toBe('gpt-6-luna');
    });

    it('no explicit model names the machine default, so a thread pinned by an earlier turn is reset', () => {
        expect(resolveCodexTurnModel(undefined, 'gpt-5.6-sol')).toBe('gpt-5.6-sol');
    });

    it('unknown machine default → omitted (Codex decides)', () => {
        expect(resolveCodexTurnModel(undefined, undefined)).toBeUndefined();
    });

    it('runCodex sends the resolved model on thread start and on every turn', () => {
        const source = readFileSync(new URL('./runCodex.ts', import.meta.url), 'utf8');
        expect(source).toContain('const turnModel = resolveCodexTurnModel(message.mode.model, machineDefaultModel);');
        expect(source).toContain('machineDefaultModel = configured?.model ?? discoveredModels.find((model) => model.isDefault)?.model;');
        expect(source).toMatch(/startThread\(\{\n\s*model: turnModel,/);
        expect(source).toMatch(/sendTurnAndWait\([\s\S]{0,300}?model: turnModel,\n\s*approvalPolicy: executionPolicy\.approvalPolicy,\n\s*sandbox: executionPolicy\.sandbox,\n\s*effort: message\.mode\.effort,/);
        expect(source).toContain('unsupportedEffortReason(discoveredModels, turnModel, message.mode.effort)');
    });
});
