import { describe, expect, it } from 'vitest';
import { getClaudeModelModes } from './modelModeOptions';

describe('getClaudeModelModes', () => {
    it('exposes current Claude Code aliases without stale version labels', () => {
        const modes = getClaudeModelModes();
        expect(modes).toEqual(expect.arrayContaining([
            expect.objectContaining({ key: 'fable', name: 'fable 5' }),
            expect.objectContaining({ key: 'opus', name: 'opus 5 (latest)' }),
            expect.objectContaining({ key: 'sonnet', name: 'sonnet 5 (latest)' }),
            expect.objectContaining({ key: 'haiku', name: 'haiku 4.5' }),
            expect.objectContaining({ key: 'best' }),
            expect.objectContaining({ key: 'opusplan' }),
        ]));
        expect(modes.map((mode) => mode.name).join(' ')).not.toMatch(/opus 4\.8|sonnet 4\.6/);
    });
});
