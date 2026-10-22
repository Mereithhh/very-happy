import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Sidebar wiring (B-721)', () => {
  const src = readFileSync(new URL('./Sidebar.tsx', import.meta.url), 'utf8');
  const row = readFileSync(new URL('./SidebarTeamRow.tsx', import.meta.url), 'utf8');
  it('every grouping view renders team headers through SidebarTeamRow (one render path)', () => {
    expect(src.match(/<SidebarTeamRow\b/g)).toHaveLength(1);
    expect(src).not.toContain('className="sb-team-main"');
    expect(src).toContain('const leadId = teamLeadSessionId(team);');
  });
  it('the context menu offers the board and the lead', () => {
    expect(row).toContain("{ key: 'open-board', label: copy.openBoard, icon: LayoutDashboard, onSelect: () => props.onNavigate(target.boardHref) }");
    expect(row).toContain("key: 'open-lead', label: copy.openLead");
    expect(row).toContain('<ActionContextMenu items={items}>');
  });
});

describe('Sidebar wiring (B-756)', () => {
  const src = readFileSync(new URL('./Sidebar.tsx', import.meta.url), 'utf8');
  it('the tag lens puts a 「项目」 area on top and keeps it out of ⌘1–9 / reorder', () => {
    expect(src).toContain("out.unshift(collapsibleSection('tag-lens:projects'");
    expect(src).toContain('.filter((r) => !r.teamInactiveFold && !r.projectEntry)');
    expect(src).toContain('const i = r.share || r.teamInactiveFold || r.projectEntry ? -1 : flat++;');
  });
  it('outside the project lens a session row names its project', () => {
    expect(src).toContain("const chipProjects = projectsSnap.status === 'ready' && !(orderable && groupMode === 'project');");
    expect(src).toContain('projectChip={projectChipOf(r)}');
  });
  it('a project head carries ＋ / ⚙ and the shared project menu on right-click / long-press', () => {
    expect(src).toContain('{sec.label !== undefined && wrapProjectHead(sec.project, (');
    expect(src).toContain('onClick={() => navigate(projectSettingsPath(sec.project!.id))}');
    expect(src).toContain('<ActionContextMenu items={projectMenuItems(project, {');
  });
});
