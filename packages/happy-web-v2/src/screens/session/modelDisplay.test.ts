import { describe, expect, it } from 'vitest';
import { deriveRunningModelSubtitle } from './modelDisplay';

const base = { isClaude: true, selectedKey: 'opus', running: 'claude-opus-5' };

describe('deriveRunningModelSubtitle', () => {
    it('reports the model the CLI says is running, without the claude- prefix', () => {
        expect(deriveRunningModelSubtitle(base)).toBe('opus-5');
    });

    it('stays silent when the CLI has published nothing (older CLI, or no turn yet)', () => {
        expect(deriveRunningModelSubtitle({ ...base, running: undefined })).toBeUndefined();
        expect(deriveRunningModelSubtitle({ ...base, running: null })).toBeUndefined();
    });

    it('stays silent for the default pick — that option label already shows the resolved model', () => {
        expect(deriveRunningModelSubtitle({ ...base, selectedKey: 'default' })).toBeUndefined();
        expect(deriveRunningModelSubtitle({ ...base, selectedKey: null })).toBeUndefined();
    });

    it('is claude-only: other flavors publish their own model list and current code', () => {
        expect(deriveRunningModelSubtitle({ ...base, isClaude: false })).toBeUndefined();
    });

    it('reports a mismatch plainly rather than hiding it', () => {
        // The whole point: intent says sonnet, the agent is still on opus.
        expect(deriveRunningModelSubtitle({ isClaude: true, selectedKey: 'sonnet', running: 'claude-opus-5' })).toBe('opus-5');
    });
});
