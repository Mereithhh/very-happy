import { describe, expect, it } from 'vitest';
import { localSettingsDefaults, localSettingsParse } from './localSettings';
import { resolveNewSessionPermissionMode } from './agentDefaults';

describe('new-session safety default migration', () => {
    it('starts a genuinely fresh device in review-first mode', () => {
        expect(localSettingsDefaults.newSessionReviewFirst).toBe(true);
        expect(localSettingsParse(undefined).newSessionReviewFirst).toBe(true);
    });

    it('preserves auto-apply behavior for an existing saved device', () => {
        expect(localSettingsParse({ themePreference: 'dark' }).newSessionReviewFirst).toBe(false);
    });

    it('honors an explicit choice on a current device', () => {
        expect(localSettingsParse({ newSessionReviewFirst: true }).newSessionReviewFirst).toBe(true);
        expect(localSettingsParse({ newSessionReviewFirst: false }).newSessionReviewFirst).toBe(false);
    });
});

describe('new-session permission resolution', () => {
    it('uses review-only agent modes on a fresh device', () => {
        expect(resolveNewSessionPermissionMode({}, 'claude', true)).toBe('plan');
        expect(resolveNewSessionPermissionMode({}, 'codex', true)).toBe('read-only');
    });

    it('preserves established and explicitly configured auto-apply modes', () => {
        expect(resolveNewSessionPermissionMode({}, 'claude', false)).toBe('bypassPermissions');
        expect(resolveNewSessionPermissionMode({ codex: { permissionMode: 'safe-yolo' } }, 'codex', false)).toBe('safe-yolo');
    });

    it('lets an explicit persisted default win over the review-first fallback', () => {
        expect(resolveNewSessionPermissionMode({ claude: { permissionMode: 'bypassPermissions' } }, 'claude', true))
            .toBe('bypassPermissions');
        expect(resolveNewSessionPermissionMode({ codex: { permissionMode: 'yolo' } }, 'codex', true))
            .toBe('yolo');
    });
});
