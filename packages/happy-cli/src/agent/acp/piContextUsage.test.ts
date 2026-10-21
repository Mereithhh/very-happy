import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { piWindowConfigured, readPiModelsJson, resolvePiContextUsage, type PiContextReport } from './piContextUsage';

// What B-688's form wrote before B-727: models as bare `{ id }` → pi assumes 128000.
const modelsJson = {
    providers: {
        gw: { baseUrl: 'https://gw.example/v1', api: 'openai-completions', models: [{ id: 'claude-opus-5-5' }, { id: 'deepseek-v4-1-flash-1017' }, { id: 'glm-5.3', contextWindow: 200000 }] },
        other: { baseUrl: 'https://other.example/v1', models: [{ id: 'deepseek-v4-1-flash-1017' }] },
        anthropic: { modelOverrides: { 'claude-sonnet-5': { contextWindow: 1000000 } } },
    },
};
const report = (over: Partial<PiContextReport> = {}): PiContextReport => ({ source: 'pi', tokens: 90000, contextWindow: 128000, model: 'claude-opus-5-5', provider: 'gw', event: 'turn_end', peers: [], ...over });

describe('piWindowConfigured (B-727 denominator provenance)', () => {
    it('treats an explicit entry, a modelOverride or a built-in model as configured', () => {
        expect(piWindowConfigured(modelsJson, 'gw', 'glm-5.3')).toBe(true);
        expect(piWindowConfigured(modelsJson, 'anthropic', 'claude-sonnet-5')).toBe(true);
        expect(piWindowConfigured(modelsJson, 'anthropic', 'claude-opus-5-5')).toBe(true);
        expect(piWindowConfigured(modelsJson, 'openai', 'gpt-5.5')).toBe(true);
    });
    it('flags a models.json entry without contextWindow as pi\'s default', () => {
        expect(piWindowConfigured(modelsJson, 'gw', 'claude-opus-5-5')).toBe(false);
    });
    it('falls back to the old reading when models.json or the model is unknown', () => {
        expect(piWindowConfigured(null, 'gw', 'claude-opus-5-5')).toBe(true);
        expect(piWindowConfigured(modelsJson, null, 'claude-opus-5-5')).toBe(true);
    });
});

describe('resolvePiContextUsage', () => {
    it('configured > inferred > unknown', () => {
        expect(resolvePiContextUsage(report({ model: 'glm-5.3', contextWindow: 200000 }), modelsJson, null, 7)).toMatchObject({ windowSource: 'configured', contextWindow: 200000 });
        expect(resolvePiContextUsage(report({ peers: [{ provider: 'anthropic', contextWindow: 1000000 }] }), modelsJson, null, 7)).toMatchObject({ windowSource: 'inferred', contextWindow: 1000000, tokens: 90000 });
        // No other source → unknown; contextWindow keeps pi's number for webs that predate windowSource.
        expect(resolvePiContextUsage(report({ model: 'deepseek-v4-1-flash-1017' }), modelsJson, null, 7)).toMatchObject({ windowSource: 'unknown', contextWindow: 128000 });
    });
    it('never infers from a peer that pi defaulted too, or from peers that disagree', () => {
        expect(resolvePiContextUsage(report({ model: 'deepseek-v4-1-flash-1017', peers: [{ provider: 'other', contextWindow: 128000 }] }), modelsJson, null, 7).windowSource).toBe('unknown');
        expect(resolvePiContextUsage(report({ peers: [{ provider: 'a', contextWindow: 1000000 }, { provider: 'b', contextWindow: 200000 }] }), modelsJson, null, 7).windowSource).toBe('unknown');
    });
    it('passes pi\'s numerator through untouched — no accumulation across turns', () => {
        const first = resolvePiContextUsage(report({ tokens: 90000 }), modelsJson, null, 1);
        expect(resolvePiContextUsage(report({ tokens: 91000 }), modelsJson, first, 2).tokens).toBe(91000);
    });
    it('marks a compaction and keeps the mark until the next measured answer', () => {
        const compacted = resolvePiContextUsage(report({ tokens: null, event: 'session_compact' }), modelsJson, null, 10);
        expect(compacted).toMatchObject({ tokens: null, compactedAt: 10 });
        expect(resolvePiContextUsage(report({ tokens: null, event: 'agent_end' }), modelsJson, compacted, 11).compactedAt).toBe(10);
        expect(resolvePiContextUsage(report({ tokens: 30000 }), modelsJson, compacted, 12).compactedAt).toBeNull();
    });
});

describe('readPiModelsJson', () => {
    it('reads PI_CODING_AGENT_DIR/models.json; null for missing or commented files', () => {
        const dir = mkdtempSync(join(tmpdir(), 'b727-'));
        expect(readPiModelsJson({ PI_CODING_AGENT_DIR: dir }, dir)).toBeNull();
        writeFileSync(join(dir, 'models.json'), JSON.stringify(modelsJson));
        expect(readPiModelsJson({ PI_CODING_AGENT_DIR: dir }, '/nonexistent')).toEqual(modelsJson);
        writeFileSync(join(dir, 'models.json'), '// note\n{}');
        expect(readPiModelsJson({ PI_CODING_AGENT_DIR: dir }, '/nonexistent')).toBeNull();
    });
});
