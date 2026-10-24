/**
 * B-798 (U1): long-press / right-click is only a shortcut. Every `<ActionContextMenu items={X}>`
 * needs a visible `<ActionDropdownMenu items={X}>` (the row's ⋯) in the same file, over the same
 * items expression, or a `touch-parity-allow: <reason>` comment on one of the three lines above it.
 * The audit found four rows whose menu was reachable only by a 0.7s press (sidebar project and team,
 * board card, notes list). TOUCH_PARITY_ALLOWLIST only shrinks: a fixed entry fails as stale.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('..', import.meta.url));

/** `<file relative to src> <items expression>` → the PR expected to add the ⋯. */
const TOUCH_PARITY_ALLOWLIST = new Map<string, string>([
  ['screens/sessions/SidebarTeamRow.tsx items', 'B-798 PR C'],
  ['screens/notes/NotesList.tsx menuFor(note)', 'B-798 PR D'],
  ['screens/board/BoardCard.tsx menuItems', 'B-798 PR D'],
  ['screens/workspace/WorkspaceTabsView.tsx items', 'B-798 PR D'],
]);

/** The balanced `{…}` expression of `items=` inside a JSX opening tag that starts at `from`. */
function itemsExpr(src: string, from: string, at: number): string | null {
  const tagEnd = src.indexOf('>', at);
  const tag = src.slice(at, tagEnd < 0 ? undefined : tagEnd);
  const start = tag.indexOf('items={');
  if (start < 0 || !tag.startsWith(from)) return null;
  let depth = 0;
  for (let i = start + 6; i < tag.length + 400 && at + i < src.length; i++) {
    const ch = src[at + i];
    if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return src.slice(at + start + 7, at + i).replace(/\s+/g, ' ').trim();
  }
  return null;
}

function contextMenusWithoutDropdown(src: string): string[] {
  const dropdowns = new Set<string>();
  for (const m of src.matchAll(/<ActionDropdownMenu\b/g)) {
    const expr = itemsExpr(src, '<ActionDropdownMenu', m.index!);
    if (expr) dropdowns.add(expr);
  }
  const missing: string[] = [];
  const lines = src.split('\n');
  for (const m of src.matchAll(/<ActionContextMenu\b/g)) {
    const expr = itemsExpr(src, '<ActionContextMenu', m.index!) ?? '?';
    if (dropdowns.has(expr)) continue;
    const line = src.slice(0, m.index).split('\n').length;
    if (lines.slice(Math.max(0, line - 4), line).some((l) => /touch-parity-allow:\s*[^\s*}]/.test(l))) continue;
    missing.push(expr);
  }
  return missing;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : sourceFiles(p);
    return /\.tsx$/.test(e.name) && !/\.test\.tsx$/.test(e.name) ? [p] : [];
  });
}

describe('B-798 touch parity: every long-press menu has a visible ⋯', () => {
  const found = sourceFiles(SRC).flatMap((file) => {
    const rel = relative(SRC, file).split(sep).join('/');
    if (rel === 'ui/Menu.tsx') return [];
    return contextMenusWithoutDropdown(readFileSync(file, 'utf8')).map((expr) => `${rel} ${expr}`);
  });

  it('no ActionContextMenu without an ActionDropdownMenu over the same items (outside the allowlist)', () => {
    expect(found.filter((k) => !TOUCH_PARITY_ALLOWLIST.has(k))).toEqual([]);
  });

  it('the allowlist has no stale entries (fixed rows must be removed)', () => {
    expect([...TOUCH_PARITY_ALLOWLIST.keys()].filter((k) => !found.includes(k))).toEqual([]);
  });

  it('the scan pairs by items expression and honours touch-parity-allow', () => {
    expect(contextMenusWithoutDropdown('<ActionContextMenu items={a}><div/></ActionContextMenu><ActionDropdownMenu items={a} align="end"><b/></ActionDropdownMenu>')).toEqual([]);
    expect(contextMenusWithoutDropdown('<ActionContextMenu items={rowItems(r)} sheetTitle={t}><div/></ActionContextMenu><ActionDropdownMenu items={other}><b/></ActionDropdownMenu>')).toEqual(['rowItems(r)']);
    expect(contextMenusWithoutDropdown('{/* touch-parity-allow: the tab has a visible ✕ */}\n<ActionContextMenu items={a}><div/></ActionContextMenu>')).toEqual([]);
    expect(contextMenusWithoutDropdown('{/* touch-parity-allow: */}\n<ActionContextMenu items={a}><div/></ActionContextMenu>')).toEqual(['a']);
    expect(contextMenusWithoutDropdown('<ActionDropdownMenu align="end" items={[\n  { key: "x" },\n]}><b/></ActionDropdownMenu>')).toEqual([]);
  });
});
