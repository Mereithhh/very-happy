import { describe, expect, it } from 'vitest';
import { localSettingsParse } from '@/sync/localSettings';
import { resolveSidebarGroupMode } from './sidebarWorkspaceGroups';

describe('sidebar grouping preferences', () => {
    it('starts new users with a reorderable flat list', () => {
        const prefs = localSettingsParse({});
        expect(resolveSidebarGroupMode(prefs.sidebarGroupMode, prefs.sidebarGroupByTag)).toBe('none');
    });
    it.each(['workspace', 'tag', 'none'] as const)('preserves the saved %s choice', (mode) => {
        const prefs = localSettingsParse({ sidebarGroupMode: mode });
        expect(resolveSidebarGroupMode(prefs.sidebarGroupMode, prefs.sidebarGroupByTag)).toBe(mode);
    });
    it('keeps legacy tag grouping', () => {
        const prefs = localSettingsParse({ sidebarGroupByTag: true });
        expect(resolveSidebarGroupMode(prefs.sidebarGroupMode, prefs.sidebarGroupByTag)).toBe('tag');
    });
});
