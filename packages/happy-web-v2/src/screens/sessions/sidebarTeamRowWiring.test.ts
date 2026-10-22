import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Sidebar wiring (B-721 / B-762 / B-773)', () => {
  const src = readFileSync(new URL('./Sidebar.tsx', import.meta.url), 'utf8');
  const row = readFileSync(new URL('./SidebarTeamRow.tsx', import.meta.url), 'utf8');
  it('team nodes render through SidebarTeamRow only (one render path, tree lens only)', () => {
    expect(src.match(/<SidebarTeamRow\b/g)).toHaveLength(1);
    expect(src).not.toContain('className="sb-team-main"');
  });
  it('B-759: the row opens the team page; the menu offers team page, lead and settings', () => {
    expect(row).toContain("{ key: 'open-board', label: copy.openBoard, icon: LayoutDashboard, onSelect: () => props.onNavigate(target.href) }");
    expect(row).toContain("key: 'open-lead', label: copy.openLead");
    expect(row).toContain("{ key: 'settings', label: copy.settings, icon: Settings2, onSelect: () => props.onNavigate(target.settingsHref) }");
    expect(row).toContain('<ActionContextMenu items={items} sheetTitle={team.name}>');
    expect(row).not.toContain('sb-team-board');
  });
  it('B-759: the menu’s 团队设置 lands on the settings tab (?view=settings)', () => {
    const teams = readFileSync(new URL('../teams/TeamsScreen.tsx', import.meta.url), 'utf8');
    expect(teams).toContain('if (searchParams.get("view") === "settings") {\n      setView("settings");');
  });
  it('B-762: hints, folds and team nodes stay out of ⌘1–9 / reorder', () => {
    expect(src).toContain('.filter((r) => !r.teamInactiveFold && !r.teamEmptyHint && !r.projectEmptyHint && !r.team)');
    expect(src).toContain('const i = r.share || r.teamInactiveFold || r.teamEmptyHint || r.projectEmptyHint || r.team ? -1 : flat++;');
  });
  it('B-762 (D1): no 「项目」 area in the tag lens — the 项目 capability carries the badge', () => {
    expect(src).not.toContain('tag-lens:projects');
    expect(src).toContain('projectAttention: projectBadgeTotal');
  });
  it('B-762 review: the owner chip carries a real ellipsis on its name, capped at 40% of the line', () => {
    const css = readFileSync(new URL('./sidebar.css', import.meta.url), 'utf8');
    expect(css).toContain('.sb-row-project-name { min-width: 0; max-width: calc(40cqw - 23px); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }');
    expect(src).toContain('<span className="sb-row-project-name">{ownerChip.name}</span>');
  });
  it('B-772 (QA4 O4): the owner chip never shrinks below ~3 characters of its name', () => {
    const css = readFileSync(new URL('./sidebar.css', import.meta.url), 'utf8');
    expect(css).toMatch(/\.sb-row-project \{[^}]*flex: 1 1 calc\(3em \+ 23px\); min-width: calc\(3em \+ 23px\); max-width: max-content;/);
  });
  it('B-773 (QA5): lead/member title text keeps ≥ 6em (or all of it) — the 「负责人」 tag is outside the title box, chips wrap off the one-line row first', () => {
    // Measured in Chromium (树 / 最近 / 按标签 × 1440 with a 260 / 240 sidebar + 390 coarse × light / dark, scene=crowded) with mutations: tmp/vh-team-B-773/assert-titles.mjs, mutate.sh.
    const css = readFileSync(new URL('./sidebar.css', import.meta.url), 'utf8');
    expect(src).toContain('? <><span className="sb-lead-tag">{row.teamLabel}</span><span className="sb-row-title">{row.title}</span></>');
    expect(css).toMatch(/\.sb-row-title-line \{[^}]*flex-wrap: wrap;[^}]*max-height: 1lh;\s*overflow: hidden;\s*\}/);
    expect(css).toContain('.sb-row-text:has(> .sb-row-title-line) { container-type: inline-size; }');
    expect(css).toMatch(/@container \(max-width: 139px\) \{\s*\.sb-row-title-line:has\(> \.sb-lead-tag\) \{ --lead-w: 0px; \}\s*\.sb-row-title-line > \.sb-lead-tag \{ position: absolute;/);
    expect(css).toMatch(/\.sb-row-title-line \.sb-row-title \{\s*flex: 1000 1 0;\s*min-width: min\(var\(--title-min\), 100% - var\(--lead-w\)\);\s*max-width: max-content;/);
    // 6em on lead/member rows; 5em elsewhere, or the default 260px sidebar drops every project chip / P0 tag
    expect(css).toMatch(/\.sb-row-title-line \{\s*--lead-w: 0px;\s*--title-min: 5em;/);
    expect(css).toContain('.sb-row-title-line--team { --title-min: 6em; }');
    expect(src).toContain("<span className={`sb-row-title-line${row.teamRole ? ' sb-row-title-line--team' : ''}`}>");
    expect(css).toContain('.sb-row-title-line:has(> .sb-lead-tag) { --lead-w: 56px; }');
    expect(css).toMatch(/\.sb-lead-tag \{\s*flex: none; max-width: calc\(56px - var\(--sp-2\)\);/);
    expect(css).toContain('.sb-row-tags { display: contents; }');
  });
});
