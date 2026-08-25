import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('LanguageSwitcher presentation contract', () => {
  const source = readFileSync(new URL('./LanguageSwitcher.tsx', import.meta.url), 'utf8');
  const styles = readFileSync(new URL('./languageSwitcher.css', import.meta.url), 'utf8');

  it('uses a themed radio menu instead of the browser select control', () => {
    expect(source).toContain('<DropdownMenu.RadioGroup');
    expect(source).toContain('<DropdownMenu.RadioItem');
    expect(source).not.toContain('<select');
    expect(source).not.toContain('<option');
  });

  it('keeps explicit focus, selected, reduced-motion, and touch states', () => {
    expect(styles).toContain(":focus-visible");
    expect(styles).toContain("[data-state='checked']");
    expect(styles).toContain('@media (pointer: coarse)');
    expect(styles).toContain('@media (prefers-reduced-motion: reduce)');
  });
});
