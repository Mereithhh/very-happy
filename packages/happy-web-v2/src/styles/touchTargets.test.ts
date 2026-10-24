/**
 * B-798 E (P1-4 … P1-6): the touch-target floor for component-private controls.
 *
 * The audit found each of these under 44px on a phone (settings switches 40×24, row icon
 * buttons 32, usage range 27, project-settings nav 36, permission rows 39, directory-picker
 * crumbs ~21, …) and one control collapsed outright (待办「待处理 / 已完成」: 24px wide, labels
 * overlapping). The fixes are CSS, and the trap that let several of them slip is the cascade:
 * a coarse rule placed ABOVE an equal-specificity base rule, or a coarse selector weaker than
 * the base one (`.rva-viewed` vs `.rva-viewed.vh-checkbox`), silently loses. So every case is
 * pinned as "a coarse rule sets the size AND wins over every base rule for that property".
 * The rendered sizes were measured with an elementFromPoint walk in Chromium (task evidence).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
const css = (rel: string) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '');

type Rule = { media: string | null; selectors: string[]; body: string; index: number };

/** Style rules in source order; @media bodies are walked with their prelude. */
function rules(src: string): Rule[] {
  const out: Rule[] = [];
  const walk = (text: string, media: string | null) => {
    let i = 0;
    while (i < text.length) {
      const open = text.indexOf('{', i);
      if (open < 0) break;
      const prelude = text.slice(i, open).trim();
      let depth = 1; let j = open + 1;
      while (depth && j < text.length) { if (text[j] === '{') depth++; else if (text[j] === '}') depth--; j++; }
      const body = text.slice(open + 1, j - 1);
      if (prelude.startsWith('@media')) walk(body, prelude);
      else if (!prelude.startsWith('@')) out.push({ media, selectors: prelude.split(',').map((s) => s.trim()), body, index: out.length });
      i = j;
    }
  };
  walk(src, null);
  return out;
}

const isCoarse = (m: string | null) => !!m && /pointer:\s*coarse/.test(m);
const decl = (body: string, prop: string) => body.match(new RegExp(`(?:^|[;{\\s])${prop}\\s*:\\s*([^;]+)`))?.[1].trim();
const floor = (v: string | undefined) => !!v && (/var\(--hit\)/.test(v) || /^44px$/.test(v));

/**
 * `selector` gets a coarse `prop` at the 44px floor that beats every base declaration of `prop`
 * on the same selector (later in the file — same specificity), and any base declaration on a
 * MORE specific compound (`base`) is matched by the coarse selector itself.
 */
function expectCoarseFloor(file: string, selector: string, prop: string) {
  const all = rules(css(file));
  const coarse = all.filter((r) => isCoarse(r.media) && r.selectors.includes(selector) && floor(decl(r.body, prop)));
  expect(coarse.length, `${file}: coarse ${selector} { ${prop}: var(--hit) }`).toBeGreaterThan(0);
  const last = coarse[coarse.length - 1];
  const base = all.filter((r) => !isCoarse(r.media) && r.selectors.includes(selector) && decl(r.body, prop) !== undefined);
  for (const b of base) expect(last.index, `${file}: coarse ${selector} must come after the base ${prop}`).toBeGreaterThan(b.index);
  // No later coarse rule on the same selector lowers it again.
  const later = all.filter((r) => isCoarse(r.media) && r.selectors.includes(selector) && r.index > last.index && decl(r.body, prop) !== undefined);
  expect(later, `${file}: a later coarse ${selector} overrides ${prop}`).toEqual([]);
}

describe('B-798 --hit token and .vh-hit', () => {
  it('--hit is the 44px floor', () => {
    expect(css('styles/tokens.css')).toMatch(/--hit:\s*44px;/);
  });
  it('.vh-hit centres a ≥ --hit ::after on touch only and never displaces a positioned host', () => {
    const all = rules(css('styles/surfaces.css'));
    const after = all.find((r) => r.selectors.includes('.vh-hit::after'));
    expect(after && isCoarse(after.media)).toBe(true);
    expect(decl(after!.body, 'width')).toBe('max(100%, var(--hit))');
    expect(decl(after!.body, 'height')).toBe('max(100%, var(--hit))');
    expect(decl(after!.body, 'transform')).toBe('translate(-50%, -50%)');
    // zero specificity: .vh-copy--overlay keeps position:absolute
    const host = all.find((r) => r.selectors.includes(':where(.vh-hit)'));
    expect(decl(host!.body, 'position')).toBe('relative');
    expect(all.some((r) => r.selectors.includes('.vh-hit') && decl(r.body, 'position'))).toBe(false);
  });
});

describe('B-798 P1-4 text-only segmented controls keep their intrinsic width', () => {
  it('size containment is dropped unless a segment carries an icon', () => {
    const all = rules(css('styles/surfaces.css'));
    const optOut = all.find((r) => r.selectors.includes('.vh-segmented:not(:has(svg))'));
    expect(optOut && decl(optOut.body, 'container-type')).toBe('normal');
    const base = all.find((r) => r.selectors.includes('.vh-segmented') && decl(r.body, 'container-type'));
    expect(optOut!.index).toBeGreaterThan(base!.index);
    expect(decl(base!.body, 'container-type')).toBe('inline-size');
  });
  it('the todo filter is still a plain text .vh-segmented', () => {
    const panel = read('screens/todos/BuiltinTodosPanel.tsx');
    const seg = panel.slice(panel.indexOf('<div className="vh-segmented" role="group"'), panel.indexOf('</div>', panel.indexOf('<div className="vh-segmented" role="group"')));
    expect(seg).toContain('aria-pressed');
    expect(seg).not.toMatch(/<[A-Z]\w*\s+size=/); // no lucide icon → no container query needed
  });
});

describe('B-798 P1-6 coarse sizes win the cascade', () => {
  const cases: Array<[string, string, string]> = [
    ['screens/settings/settings.css', '.set-icon-btn', 'width'],
    ['screens/settings/settings.css', '.set-icon-btn', 'height'],
    ['screens/settings/settings.css', '.set-voice-preview', 'width'],
    ['screens/settings/settings.css', '.set-voice-preview', 'height'],
    ['screens/settings/settings.css', '.set-seg__btn', 'min-height'],
    ['screens/settings/settings.css', '.settings-content .vh-item.is-interactive', 'min-height'],
    ['screens/settings/settings.css', '.set-range', 'height'],
    ['screens/projects/projects.css', '.pj-settings-nav a', 'height'],
    ['screens/session/modemenu.css', '.mm-item', 'min-height'],
    ['screens/session/reviewAll/reviewAll.css', '.rva-viewed.vh-checkbox', 'min-height'],
    ['screens/todos/todos.css', '.td-action', 'min-width'],
    ['screens/sessions/newsession.css', '.ns-agent', 'min-height'],
    ['screens/sessions/newsession.css', '.ns-preset', 'min-height'],
    ['screens/sessions/newsession.css', '.ns-connect-link', 'min-height'],
    ['screens/sessions/newsession.css', '.ns-save', 'min-width'],
    ['screens/sessions/newsession.css', '.ns-save', 'min-height'],
    ['screens/sessions/renamemodal.css', '.rn-tag-input', 'min-height'],
    ['ui/tagchip.css', '.vh-tag-x', 'min-width'],
    ['ui/tagchip.css', '.vh-tag-x', 'min-height'],
    ['ui/tagchip.css', '.vh-tag--btn', 'min-height'],
    ['screens/files/fsbrowser.css', '.fsb-iconbtn', 'width'],
    ['screens/files/fsbrowser.css', '.fsb-iconbtn', 'height'],
    ['screens/files/fsbrowser.css', '.fsb-row', 'min-height'],
    ['screens/files/fsbrowser.css', '.fsb-crumb', 'min-height'],
    ['screens/files/fsbrowser.css', '.fsb-crumb', 'min-width'],
    ['screens/files/fsbrowser.css', '.fsb-retry', 'min-height'],
    ['screens/files/fsbrowser.css', '.fsb-pickbtn', 'min-height'],
    ['screens/sessions/sidebar.css', '.sb-closed-reopen', 'width'],
  ];
  it.each(cases)('%s %s { %s }', (file, selector, prop) => expectCoarseFloor(file, selector, prop));

  it('the Review All coarse rule matches the base compound, not just .rva-viewed', () => {
    const all = rules(css('screens/session/reviewAll/reviewAll.css'));
    expect(all.some((r) => isCoarse(r.media) && r.selectors.includes('.rva-viewed'))).toBe(false);
  });
});

describe('B-798 P1-6 small visuals carry .vh-hit / their own touch class', () => {
  it('every settings switch takes .vh-hit', () => {
    for (const f of ['screens/settings/SettingsRoutes.tsx', 'screens/settings/VoiceSettings.tsx']) {
      const src = read(f);
      const switches = src.match(/className="set-switch(?!__)[^"]*"/g) ?? [];
      expect(switches.length, f).toBeGreaterThan(0);
      for (const s of switches) expect(s).toBe('className="set-switch vh-hit"');
    }
  });
  it('row icon buttons use .set-icon-btn, not the 32px header back class', () => {
    for (const f of ['screens/settings/SettingsRoutes.tsx', 'screens/settings/VoiceSettings.tsx', 'screens/machine/MachineScreen.tsx']) {
      expect(read(f), f).not.toContain('className="set-header__back"');
      expect(read(f), f).toContain('className="set-icon-btn"');
    }
  });
  it('overlay copy buttons, the sticky toast ✕ and directory-chip ✕ take .vh-hit', () => {
    for (const f of ['screens/session/DiffView.tsx', 'screens/session/ToolView.tsx', 'screens/session/SubagentDetail.tsx', 'screens/session/CommandView.tsx', 'screens/session/MessageView.tsx', 'screens/session/BuiltinToolView.tsx']) {
      const src = read(f);
      expect(src, f).toContain('className="vh-copy--overlay vh-hit"');
      expect(src, f).not.toContain('className="vh-copy--overlay"');
    }
    expect(read('ui/Toast.tsx')).toContain('className="vh-toast-x vh-hit"');
    for (const f of ['screens/sessions/NewSessionModal.tsx', 'screens/sessions/NewTerminalModal.tsx']) {
      expect(read(f), f).not.toContain('className="ns-preset-x"');
      expect(read(f), f).toContain('className="ns-preset-x vh-hit"');
    }
  });
});

describe('B-798 P1-5 directory picker keeps the current folder in view', () => {
  it('FsBrowser scrolls the crumb trail to its end whenever the path changes', () => {
    const src = read('screens/files/FsBrowser.tsx');
    expect(src).toContain('<nav ref={crumbsRef} className="fsb-crumbs');
    expect(src).toMatch(/useLayoutEffect\(\(\) => revealLastCrumb\(crumbsRef\.current\), \[path\]\);/);
  });
});
