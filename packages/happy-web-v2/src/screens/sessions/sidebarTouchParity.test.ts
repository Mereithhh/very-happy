/**
 * B-798 (U1, P1-1 / P1-2): long-press is only a shortcut. The sidebar tree's
 * project head (＋ / ⋯) and team row (⋯) put their actions in `.sb-tree-acts`,
 * which is visible by default; only a fine hover pointer hides it until hover.
 * Before, the project ＋ / ⋯ were `display:none` outside that query, so on touch
 * they measured 0×0 and the project menu was reachable only by a 0.7s press.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('./sidebar.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const sidebar = readFileSync(new URL('./Sidebar.tsx', import.meta.url), 'utf8');
const teamRow = readFileSync(new URL('./SidebarTeamRow.tsx', import.meta.url), 'utf8');

/** Top-level rules as [mediaPrelude | null, selector, body] in source order. */
function rules(src: string): Array<[string | null, string, string]> {
  const out: Array<[string | null, string, string]> = [];
  const walk = (text: string, media: string | null) => {
    let i = 0;
    while (i < text.length) {
      const open = text.indexOf('{', i);
      if (open < 0) break;
      const prelude = text.slice(i, open).trim();
      let depth = 1; let j = open + 1;
      while (depth && j < text.length) { if (text[j] === '{') depth++; else if (text[j] === '}') depth--; j++; }
      const body = text.slice(open + 1, j - 1);
      if (prelude.startsWith('@media')) walk(body, prelude); else out.push([media, prelude, body]);
      i = j;
    }
  };
  walk(src, null);
  return out;
}

const all = rules(css);
const hits = (cls: string) => (sel: string) => sel.split(',').some((s) => new RegExp(`\\${cls}(?![\\w-])`).test(s));
const finePointer = (m: string | null) => !!m && m.includes('hover: hover') && m.includes('pointer: fine');

describe('B-798 sidebar tree row actions on touch', () => {
  it('.sb-tree-acts is visible by default; display:none only under (hover: hover) and (pointer: fine)', () => {
    const acts = all.filter(([, sel]) => hits('.sb-tree-acts')(sel));
    const base = acts.find(([m, sel]) => m === null && sel.trim() === '.sb-tree-acts');
    expect(base?.[2]).toMatch(/display:\s*inline-flex/);
    const hiding = acts.filter(([, , body]) => /display:\s*none/.test(body));
    expect(hiding.length).toBeGreaterThan(0);
    for (const [m] of hiding) expect(finePointer(m)).toBe(true);
  });

  it('no project/team action rule hides it on coarse pointers (visibility / opacity / size)', () => {
    for (const [m, sel, body] of all) {
      if (finePointer(m) || !(hits('.sb-tree-acts')(sel) || hits('.sb-tree-act')(sel))) continue;
      expect(body).not.toMatch(/display:\s*none|visibility:\s*hidden|opacity:\s*0(?![.\d])|width:\s*0(?![.\d])/);
    }
  });

  it('the action buttons are 44px on coarse pointers, after the 28px base rule', () => {
    const base = all.findIndex(([m, sel]) => m === null && sel.trim() === '.sb-tree-act');
    const coarse = all.findIndex(([m, sel, body], i) => i > base && !!m?.includes('pointer: coarse') && sel.trim() === '.sb-tree-act' && /width:\s*44px/.test(body) && /height:\s*44px/.test(body));
    expect(base).toBeGreaterThanOrEqual(0);
    expect(coarse).toBeGreaterThan(base);
  });

  it('the project head’s ⋯ and the team row’s ⋯ open the same items as their long-press menu', () => {
    expect(sidebar).toMatch(/<ActionContextMenu items=\{projectItems\(project\)\}[\s\S]*?<span className="sb-tree-acts">[\s\S]*?<ActionDropdownMenu items=\{projectItems\(project\)\}/);
    expect(teamRow).toMatch(/<ActionContextMenu items=\{items\}[\s\S]*?<span className="sb-tree-acts">\s*<ActionDropdownMenu items=\{items\}/);
 
  });

  it('on a phone both ⋯ open the same titled bottom sheet as long-press (B-798 B: sheetTitle)', () => {
    expect(sidebar).toMatch(/<ActionDropdownMenu items=\{projectItems\(project\)\}[^>]*sheetTitle=\{project\.name\}/);
    expect(teamRow).toMatch(/<ActionDropdownMenu items=\{items\}[^>]*sheetTitle=\{team\.name\}/);
  });
});
