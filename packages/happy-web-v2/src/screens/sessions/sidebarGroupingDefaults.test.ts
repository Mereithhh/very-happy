import { describe, expect, it } from 'vitest';
import { localSettingsParse, applyLocalSettings, localSettingsDefaults } from '@/sync/localSettings';
import { legacyGroupModeFor, resolveSidebarGrouping, showTagGroupingBackNotice, usedTagGrouping } from './sidebarProjectGroups';

/**
 * B-647: the sidebar groups by project by default — for new users AND for
 * every existing device on upgrade, whatever the old lens was (saved blobs
 * carry the old default `sidebarGroupMode: 'none'`, which is why the new
 * lens lives in its own field). Only an explicit choice in the new field
 * changes it.
 *
 * B-675 (Owner 2026-10-21): tag grouping is back beside projects. 'tag' is an
 * added `sidebarGrouping` value; the default stays project and no device is
 * switched automatically — a pre-B-647 tag user gets a one-time notice.
 */
describe('sidebar grouping preferences', () => {
    it('starts new users grouped by project', () => {
        expect(localSettingsParse({}).sidebarGrouping).toBe('project');
        expect(resolveSidebarGrouping(localSettingsParse({}).sidebarGrouping)).toBe('project');
    });
    it.each(['workspace', 'tag', 'none'] as const)('an upgraded device that had saved %s is grouped by project', (mode) => {
        const prefs = localSettingsParse({ sidebarGroupMode: mode, sidebarGroupByTag: mode === 'tag' });
        expect(resolveSidebarGrouping(prefs.sidebarGrouping)).toBe('project');
        // the old fields stay readable (add-only schema) for the notice and a rollback
        expect(prefs.sidebarGroupMode).toBe(mode);
    });
    it.each(['project', 'tag', 'none'] as const)('an explicit %s in the new field is kept across a save/reload', (mode) => {
        const saved = applyLocalSettings(localSettingsDefaults, { sidebarGrouping: mode, ...legacyGroupModeFor(mode) });
        const reloaded = localSettingsParse(JSON.parse(JSON.stringify(saved)));
        expect(resolveSidebarGrouping(reloaded.sidebarGrouping)).toBe(mode);
    });
    it('a device that chose project or none under B-647 keeps it (tag is only ever added)', () => {
        expect(localSettingsParse({ sidebarGrouping: 'none', sidebarGroupMode: 'none' }).sidebarGrouping).toBe('none');
        expect(localSettingsParse({ sidebarGrouping: 'project', sidebarGroupMode: 'workspace' }).sidebarGrouping).toBe('project');
    });
    it('an unknown future value never wipes the other settings (whole-blob safeParse)', () => {
        const prefs = localSettingsParse({ sidebarGrouping: 'project', sidebarView: 'status' });
        expect(prefs.sidebarView).toBe('status');
        expect(resolveSidebarGrouping('someday')).toBe('project');
    });
    it('the schema has no zod default for the grouping fields (AGENTS 约束 1 uniformity)', () => {
        // defaults live in localSettingsDefaults only: a blob without the field parses without inventing it
        expect(localSettingsParse({ sidebarView: 'list' }).tagGroupingBackNoticeDismissed).toBe(false);
        expect(Object.prototype.hasOwnProperty.call(localSettingsDefaults, 'tagGroupingBackNoticeDismissed')).toBe(true);
    });
    it('pre-B-647 tag devices get the 「按标签分组回来了」 notice once — even if they dismissed the B-647 one', () => {
        const tagDevice = localSettingsParse({ sidebarGroupMode: 'tag', projectsTagNoticeDismissed: true });
        expect(showTagGroupingBackNotice(tagDevice)).toBe(true);
        expect(showTagGroupingBackNotice(localSettingsParse({ sidebarGroupByTag: true }))).toBe(true);
        expect(showTagGroupingBackNotice(localSettingsParse({}))).toBe(false);
        expect(showTagGroupingBackNotice(localSettingsParse({ sidebarGroupMode: 'tag', tagGroupingBackNoticeDismissed: true }))).toBe(false);
        // picking tag grouping rewrites the legacy fields to tag but the lens is tag → no notice
        expect(showTagGroupingBackNotice(localSettingsParse({ sidebarGrouping: 'tag', ...legacyGroupModeFor('tag') }))).toBe(false);
        // picking project/none in the menu clears the legacy tag marker for good
        expect(usedTagGrouping(legacyGroupModeFor('project').sidebarGroupMode, legacyGroupModeFor('project').sidebarGroupByTag)).toBe(false);
    });
});
