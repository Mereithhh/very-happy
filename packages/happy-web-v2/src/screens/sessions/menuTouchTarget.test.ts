/**
 * B-653: every shared dropdown row (.vh-menu-item — session ⋯, group, header ＋/⋯ …)
 * is a 44px touch target under pointer: coarse. The previous coarse padding rule sat
 * ABOVE the base rule at equal specificity, so the base padding won (34.8px measured
 * in Chromium). This pins the cascade: the last coarse word on .vh-menu-item comes
 * after the base rule and sets min-height 44px; no scoped per-menu override remains.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// B-798: the shared menu styles moved from sidebar.css to ui/menu.css.
const css = readFileSync(new URL('../../ui/menu.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

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

describe('B-653 menu rows are 44px on touch', () => {
  const all = rules(css);
  const isItem = (sel: string) => sel.split(',').some((s) => s.trim() === '.vh-menu-item');
  const base = all.findIndex(([m, sel, body]) => m === null && isItem(sel) && /padding:/.test(body));
  const coarse = all.map((r, i) => [r, i] as const).filter(([[m, sel]]) => m?.includes('pointer: coarse') && isItem(sel));

  it('the coarse .vh-menu-item rule follows the base rule and sets min-height 44px', () => {
    expect(base).toBeGreaterThanOrEqual(0);
    expect(coarse.length).toBe(1);
    const [[, , body], index] = coarse[0];
    expect(index).toBeGreaterThan(base);
    expect(body).toMatch(/(^|;|\s)min-height:\s*44px/);
  });

  it('no per-menu touch override is left behind (the fix is global)', () => {
    expect(css).not.toContain('sb-touch-menu');
    expect(readFileSync(new URL('./sidebar.css', import.meta.url), 'utf8')).not.toContain('sb-touch-menu');
    expect(readFileSync(new URL('./Sidebar.tsx', import.meta.url), 'utf8')).not.toContain('sb-touch-menu');
  });
});
