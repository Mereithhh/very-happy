import { describe, expect, it } from 'vitest';
import { claudeModeHash } from './claudeModeHash';
import type { EnhancedMode } from './loop';

const mode = (patch: Partial<EnhancedMode> = {}): EnhancedMode => ({ permissionMode: 'default', ...patch } as EnhancedMode);

describe('claudeModeHash (which changes force a fresh SDK Query)', () => {
    it('does NOT relaunch for a model change — claudeRemote applies it live with setModel', () => {
        expect(claudeModeHash(mode({ model: 'opus' }))).toBe(claudeModeHash(mode({ model: 'sonnet' })));
        expect(claudeModeHash(mode({ model: undefined }))).toBe(claudeModeHash(mode({ model: 'haiku' })));
    });

    it('relaunches for every field that is fixed at query() creation', () => {
        const base = claudeModeHash(mode());
        expect(claudeModeHash(mode({ fallbackModel: 'sonnet' }))).not.toBe(base);
        expect(claudeModeHash(mode({ customSystemPrompt: 'x' }))).not.toBe(base);
        expect(claudeModeHash(mode({ appendSystemPrompt: 'x' }))).not.toBe(base);
        expect(claudeModeHash(mode({ allowedTools: ['Bash'] }))).not.toBe(base);
        expect(claudeModeHash(mode({ disallowedTools: ['Bash'] }))).not.toBe(base);
        expect(claudeModeHash(mode({ effort: 'max' }))).not.toBe(base);
    });

    it('only distinguishes plan from non-plan permission modes (the rest switch live)', () => {
        expect(claudeModeHash(mode({ permissionMode: 'plan' }))).not.toBe(claudeModeHash(mode({ permissionMode: 'default' })));
        expect(claudeModeHash(mode({ permissionMode: 'bypassPermissions' })))
            .toBe(claudeModeHash(mode({ permissionMode: 'acceptEdits' })));
    });

    it('is stable for the same mode', () => {
        expect(claudeModeHash(mode({ model: 'opus', effort: 'high' })))
            .toBe(claudeModeHash(mode({ model: 'opus', effort: 'high' })));
    });
});
