import { describe, it, expect } from 'vitest';
import { sanitizeSpawnPermissionMode, ALLOWED_SPAWN_PERMISSION_MODES } from './spawnPermissionMode';

describe('sanitizeSpawnPermissionMode', () => {
    it('accepts every allowlisted mode verbatim', () => {
        for (const mode of ALLOWED_SPAWN_PERMISSION_MODES) {
            expect(sanitizeSpawnPermissionMode(mode)).toBe(mode);
        }
    });

    it('rejects unknown strings (including near-misses and injection attempts)', () => {
        expect(sanitizeSpawnPermissionMode('Default')).toBeNull();
        expect(sanitizeSpawnPermissionMode('accept-edits')).toBeNull();
        expect(sanitizeSpawnPermissionMode('')).toBeNull();
        expect(sanitizeSpawnPermissionMode(' default')).toBeNull();
        expect(sanitizeSpawnPermissionMode('default; rm -rf /')).toBeNull();
        expect(sanitizeSpawnPermissionMode('--dangerously-skip-permissions')).toBeNull();
    });

    it('rejects non-string input (absent field behaves like no flag)', () => {
        expect(sanitizeSpawnPermissionMode(undefined)).toBeNull();
        expect(sanitizeSpawnPermissionMode(null)).toBeNull();
        expect(sanitizeSpawnPermissionMode(42)).toBeNull();
        expect(sanitizeSpawnPermissionMode(true)).toBeNull();
        expect(sanitizeSpawnPermissionMode(['default'])).toBeNull();
        expect(sanitizeSpawnPermissionMode({ mode: 'default' })).toBeNull();
    });
});
