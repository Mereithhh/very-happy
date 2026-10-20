import { describe, expect, it } from 'vitest';
import { localSettingsParse } from '@/sync/localSettings';
import { usedTagGrouping } from './sidebarProjectGroups';

/**
 * B-647: the sidebar groups by project by default — for new users AND for
 * every existing device on upgrade, whatever the old lens was (saved blobs
 * carry the old default `sidebarGroupMode: 'none'`, which is why the new
 * lens lives in its own field). Only an explicit 不分组 in the new field
 * keeps a flat list.
 */
describe('sidebar grouping preferences', () => {
    it('starts new users grouped by project', () => {
        expect(localSettingsParse({}).sidebarGrouping).toBe('project');
    });
    it.each(['workspace', 'tag', 'none'] as const)('an upgraded device that had saved %s is grouped by project', (mode) => {
        const prefs = localSettingsParse({ sidebarGroupMode: mode, sidebarGroupByTag: mode === 'tag' });
        expect(prefs.sidebarGrouping).toBe('project');
        // the old fields stay readable (add-only schema) for the notice and a rollback
        expect(prefs.sidebarGroupMode).toBe(mode);
    });
    it('an explicit 不分组 in the new field is kept', () => {
        expect(localSettingsParse({ sidebarGrouping: 'none' }).sidebarGrouping).toBe('none');
    });
    it('an unknown future value never wipes the other settings (whole-blob safeParse)', () => {
        const prefs = localSettingsParse({ sidebarGrouping: 'project', sidebarView: 'status' });
        expect(prefs.sidebarView).toBe('status');
    });
    it('only devices that used tag grouping get the one-time notice, until dismissed', () => {
        const tagDevice = localSettingsParse({ sidebarGroupMode: 'tag' });
        expect(usedTagGrouping(tagDevice.sidebarGroupMode, tagDevice.sidebarGroupByTag) && !tagDevice.projectsTagNoticeDismissed).toBe(true);
        const legacy = localSettingsParse({ sidebarGroupByTag: true });
        expect(usedTagGrouping(legacy.sidebarGroupMode, legacy.sidebarGroupByTag)).toBe(true);
        const fresh = localSettingsParse({});
        expect(usedTagGrouping(fresh.sidebarGroupMode, fresh.sidebarGroupByTag)).toBe(false);
        expect(localSettingsParse({ sidebarGroupMode: 'tag', projectsTagNoticeDismissed: true }).projectsTagNoticeDismissed).toBe(true);
    });
});
