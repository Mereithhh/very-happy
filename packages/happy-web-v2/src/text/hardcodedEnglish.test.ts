import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * B-682 — user-visible English that bypasses i18n. QA found the project
 * create/delete dialogs reading「Cancel / OK」and the theme button announcing
 * "Switch to dark theme" in a Chinese UI. Both came from literals: the modal's
 * fallback button labels, and an aria-label template. This walks the app
 * sources and fails on the two shapes that leaked:
 *   1. an `aria-label` / `title` whose value is a literal starting with a Latin
 *      letter (`aria-label="close"`, `` aria-label={`Copy ${x}`} ``);
 *   2. English fallback labels in the modal provider.
 * Dev harnesses, public/legal pages (own zh/en copy) and tests are out of scope.
 */
const SRC = join(__dirname, '..');
const SKIP_DIRS = new Set(['dev', 'public', 'legal', 'testing']);
// Deliberate: a keyboard key's own name on the terminal key bar.
const ALLOW = new Set(['screens/terminal/WebTerminalScreen.tsx: aria-label="Control"']);

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (!SKIP_DIRS.has(name)) yield* walk(path);
    } else if (name.endsWith('.tsx') && !name.includes('.test.') && !name.includes('Harness')) {
      yield path;
    }
  }
}

const LITERAL_ATTR = /\b(aria-label|title)=("[A-Za-z][^"]*"|\{`[A-Za-z][^`]*`\}|\{'[A-Za-z][^']*'\}|\{"[A-Za-z][^"]*"\})/g;

describe('B-682 no hard-coded English in user-visible attributes', () => {
  it('aria-label / title literals go through i18n', () => {
    const findings: string[] = [];
    for (const file of walk(SRC)) {
      const rel = relative(SRC, file);
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(LITERAL_ATTR)) {
        const hit = `${rel}: ${m[0]}`;
        if (!ALLOW.has(hit)) findings.push(hit);
      }
    }
    expect(findings).toEqual([]);
  });

  it('the modal never falls back to English button labels', () => {
    const provider = readFileSync(join(SRC, 'modal/ModalProvider.tsx'), 'utf8');
    expect(provider).not.toMatch(/'OK'|'Cancel'/);
    expect(provider).toContain("?? t('common.cancel')");
    expect(provider).toContain("?? t('common.ok')");
  });

  it('the theme toggle label (held in a variable, so the attribute scan cannot see it) is translated', () => {
    const toggle = readFileSync(join(SRC, 'ui/QuickThemeToggle.tsx'), 'utf8');
    expect(toggle).not.toContain('Switch to');
    expect(toggle).toContain("t('settingsAppearance.switchToLight')");
    expect(toggle).toContain("t('settingsAppearance.switchToDark')");
  });
});
