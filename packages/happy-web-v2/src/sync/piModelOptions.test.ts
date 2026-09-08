import { describe, expect, it } from 'vitest';
import { collectPiModelOptions } from './piModelOptions';

const piSession = (updatedAt: number, codes: string[], flavor = 'acp') => ({
    updatedAt,
    metadata: { flavor, models: codes.map((code) => ({ code, value: code.toUpperCase() })) },
});

describe('collectPiModelOptions (B-370: Settings → Agents model list for pi)', () => {
    it("starts with 'default' and unions the registries pi sessions published, newest session first", () => {
        const options = collectPiModelOptions([
            piSession(1, ['zai/glm-5.3', 'llm-hub/claude-opus-5']),
            piSession(2, ['llm-hub/claude-fable-5-1', 'zai/glm-5.3']),
        ]);
        expect(options.map((o) => o.key)).toEqual([
            'default',
            'llm-hub/claude-fable-5-1',
            'zai/glm-5.3',
            'llm-hub/claude-opus-5',
        ]);
        expect(options[1].name).toBe('LLM-HUB/CLAUDE-FABLE-5-1');
    });

    it('ignores non-pi sessions even when they publish a model list (gemini/opencode are ACP too)', () => {
        const options = collectPiModelOptions([
            piSession(5, ['gemini-2.5-pro'], 'gemini'),
            piSession(4, ['opus'], 'claude'),
            { updatedAt: 3, metadata: null },
        ]);
        expect(options.map((o) => o.key)).toEqual(['default']);
    });

    it('keeps a saved override pickable when no session published it anymore', () => {
        const options = collectPiModelOptions([piSession(1, ['zai/glm-5.3'])], ['llm-hub/claude-fable-5-1', null, 'zai/glm-5.3']);
        expect(options.map((o) => o.key)).toEqual(['default', 'zai/glm-5.3', 'llm-hub/claude-fable-5-1']);
    });
});
