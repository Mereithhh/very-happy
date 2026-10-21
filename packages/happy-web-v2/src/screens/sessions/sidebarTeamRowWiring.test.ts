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
