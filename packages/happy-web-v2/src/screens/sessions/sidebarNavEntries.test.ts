import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { navAttentionTotal, navMenuLabel, sidebarNavEntries } from './sidebarNavEntries';

const all = { teamsVisible: true, automationsVisible: true, automationAttention: 0, incomingPeople: 0 };

describe('sidebarNavEntries (B-641)', () => {
  it('lists every secondary entry in the desktop order with its route', () => {
    expect(sidebarNavEntries(all).map((e) => [e.key, e.path])).toEqual([
      ['teams', '/teams'],
      ['automations', '/automations'],
      ['todos', '/todos'],
      ['people', '/people'],
      ['help', '/help'],
    ]);
  });

  it('keeps the existing visibility gates for teams and automations', () => {
    const keys = sidebarNavEntries({ ...all, teamsVisible: false, automationsVisible: false }).map((e) => e.key);
    expect(keys).toEqual(['todos', 'people', 'help']);
  });

  it('a folded entry never hides a pending decision: the ⋯ total sums every count', () => {
    const entries = sidebarNavEntries({ ...all, automationAttention: 2, incomingPeople: 1 });
    expect(navAttentionTotal(entries)).toBe(3);
    expect(navAttentionTotal(sidebarNavEntries(all))).toBe(0);
    // a hidden automations entry contributes nothing
    expect(navAttentionTotal(sidebarNavEntries({ ...all, automationsVisible: false, automationAttention: 4 }))).toBe(0);
  });

  it('menu labels carry the count only when non-zero', () => {
    expect(navMenuLabel('自动化', 2)).toBe('自动化 · 2');
    expect(navMenuLabel('待办', 0)).toBe('待办');
  });
});

describe('Sidebar wiring (B-641)', () => {
  const src = readFileSync(new URL('./Sidebar.tsx', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  it('the nav column is desktop-only; phones get header ＋ and ⋯ menus', () => {
    expect(src).toContain('{isDesktop && <nav className="sb-products"');
    expect(src).toContain('{!isDesktop && (\n            <ActionDropdownMenu align="end" sideOffset={4} contentClassName="sb-touch-menu" items={createItems}>');
    expect(src).toContain('items={navEntries.map((e) => ({ key: e.key, label: navMenuLabel(navName[e.key], e.attention)');
    expect(src).toContain('{navAttention > 0 && <span className="sb-more-attn mono"');
  });

  it('desktop nav and phone ⋯ menu read the same entry list', () => {
    expect(src).toContain('{navEntries.map((e) => {');
    expect(src).not.toContain("onClick={() => navigate('/todos')}");
  });
});
