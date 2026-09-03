import { describe, expect, it } from 'vitest';
import { compactResolvedModelCode, getClaudeModelModes, getHardcodedModelModes, relabelDefaultModel } from './modelModeOptions';

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
