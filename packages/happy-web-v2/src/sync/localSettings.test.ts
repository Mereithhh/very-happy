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

    it('pi uses the Claude permission-mode KEYS (B-350) but its own defaults slot (B-370)', () => {
        expect(resolveNewSessionPermissionMode({}, 'pi', false)).toBe('bypassPermissions');
        // review-first: the pi-side gate treats plan/acceptEdits as default, so `default` is the honest key
        expect(resolveNewSessionPermissionMode({}, 'pi', true)).toBe('default');
        // a Claude override is Claude's business now
        expect(resolveNewSessionPermissionMode({ claude: { permissionMode: 'default' } }, 'pi', false)).toBe('bypassPermissions');
        expect(resolveNewSessionPermissionMode({ pi: { permissionMode: 'default' } }, 'pi', false)).toBe('default');
    });

    it('lets an explicit persisted default win over the review-first fallback', () => {
        expect(resolveNewSessionPermissionMode({ claude: { permissionMode: 'bypassPermissions' } }, 'claude', true))
            .toBe('bypassPermissions');
        expect(resolveNewSessionPermissionMode({ codex: { permissionMode: 'yolo' } }, 'codex', true))
            .toBe('yolo');
    });
});

describe('optional Happy Bot entry', () => {
    it('preserves an explicit hidden entry without changing other device preferences', () => {
        const settings = localSettingsParse({ happyBotEntryVisible: false, sidebarView: 'status', sidebarGroupMode: 'workspace' });
        expect(settings.happyBotEntryVisible).toBe(false);
        expect(settings.sidebarView).toBe('status');
        expect(settings.sidebarGroupMode).toBe('workspace');
        expect(localSettingsParse({ sidebarView: 'list' }).happyBotEntryVisible).toBe(true);
    });
});
