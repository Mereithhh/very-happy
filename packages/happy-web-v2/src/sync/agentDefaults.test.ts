import { describe, expect, it } from 'vitest';
import { resolveAgentDefaultConfig, setAgentDefaultOverride } from './agentDefaults';

describe('persistent conversation defaults', () => {
    it('persists each composer selection for the same agent without losing sibling fields', () => {
        let overrides = setAgentDefaultOverride({}, 'claude', 'modelMode', 'opus');
        overrides = setAgentDefaultOverride(overrides, 'claude', 'permissionMode', 'bypassPermissions');
        overrides = setAgentDefaultOverride(overrides, 'claude', 'effortLevel', 'high');

        expect(resolveAgentDefaultConfig(overrides, 'claude')).toEqual({
            modelMode: 'opus',
            permissionMode: 'bypassPermissions',
            effortLevel: 'high',
        });
    });

    it('keeps agent defaults isolated', () => {
        const overrides = setAgentDefaultOverride({}, 'codex', 'permissionMode', 'yolo');

        expect(resolveAgentDefaultConfig(overrides, 'codex').permissionMode).toBe('yolo');
        expect(resolveAgentDefaultConfig(overrides, 'claude').permissionMode).toBe('bypassPermissions');
    });

    it('clears an explicit effort choice when the composer returns to default', () => {
        const selected = setAgentDefaultOverride({}, 'claude', 'effortLevel', 'high');
        const reset = setAgentDefaultOverride(selected, 'claude', 'effortLevel', null);

        expect(resolveAgentDefaultConfig(reset, 'claude').effortLevel).toBeNull();
        expect(reset.claude).toBeUndefined();
    });
});
