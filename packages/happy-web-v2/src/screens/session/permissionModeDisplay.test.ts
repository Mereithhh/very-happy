import { describe, expect, it } from 'vitest';
import { derivePermissionModeDisplay } from './permissionModeDisplay';

describe('derivePermissionModeDisplay (B-262 A4 seven states)', () => {
    const base = { displayed: 'bypassPermissions', published: null, dangerouslySkipPermissions: null, intentSource: 'local' as const, busy: false };
    it('confirmed / pending / conflict when the CLI publishes a mode', () => {
        expect(derivePermissionModeDisplay({ ...base, published: 'bypassPermissions' })).toBe('confirmed');
        expect(derivePermissionModeDisplay({ ...base, published: 'default', busy: true })).toBe('pending');
        expect(derivePermissionModeDisplay({ ...base, published: 'default' })).toBe('conflict');
    });
    it('startup-yolo when an old CLI recorded bypass at spawn', () => {
        expect(derivePermissionModeDisplay({ ...base, dangerouslySkipPermissions: true })).toBe('startup-yolo');
    });
    it('unconfirmed-intent vs unconfirmed-guess depends on where yolo came from', () => {
        expect(derivePermissionModeDisplay({ ...base, intentSource: 'local' })).toBe('unconfirmed-intent');
        expect(derivePermissionModeDisplay({ ...base, intentSource: 'override' })).toBe('unconfirmed-intent');
        expect(derivePermissionModeDisplay({ ...base, intentSource: 'codeDefault' })).toBe('unconfirmed-guess');
    });
    it('non-yolo without a published mode is unconfirmed-other', () => {
        expect(derivePermissionModeDisplay({ ...base, displayed: 'plan', intentSource: 'codeDefault' })).toBe('unconfirmed-other');
        expect(derivePermissionModeDisplay({ ...base, displayed: 'plan', busy: true })).toBe('pending');
    });
});
