// B-699 — text fields show focus with the caret and a border/background token,
// never the keyboard ring: browsers treat a clicked or tapped field as
// :focus-visible, so a ring there showed on every mouse click (the People
// search box). Buttons and links keep --focus-ring for keyboard navigation.
// Explicit per-component rings are caught by check-design-lint's
// `field-focus-ring`; this pins the shared selectors that lint can't judge.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const rule = (css: string, test: (selector: string) => boolean) =>
  [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selector: m[1].trim(), body: m[2] })).filter((r) => test(r.selector));

describe('text fields never get the keyboard focus ring (B-699)', () => {
  it('the global :focus-visible ring excludes text inputs, textareas and contenteditable', () => {
    const [ring] = rule(read('./base.css'), (s) => s.startsWith(':focus-visible') && !s.includes('vh-disclosure'));
    expect(ring.body).toContain('var(--focus-ring)');
    const excluded = ring.selector.slice(ring.selector.indexOf(':not('));
    expect(excluded).toMatch(/input:not\(\[type="checkbox"\]/);
    expect(excluded).toContain('textarea');
    expect(excluded).toContain('[contenteditable]');
  });
  it('fields fall back to a border token on :focus, never a ring', () => {
    const [field] = rule(read('./base.css'), (s) => s.startsWith(':where(input') && s.endsWith(':focus'));
    expect(field.body).toMatch(/outline:\s*none/);
    expect(field.body).toContain('border-color: var(--line-heavy)');
    expect(field.body).not.toContain('--focus-ring');
  });
  it('the shared Input wrapper and the Teams screen keep fields ring-free', () => {
    const [wrap] = rule(read('../ui/ui.css'), (s) => s === '.vh-input-wrap:focus-within');
    expect(wrap.body).not.toContain('--focus-ring');
    const [teams] = rule(read('../screens/teams/teams.css'), (s) => s.startsWith('.teams-screen :focus-visible'));
    expect(teams.selector).toMatch(/:not\(textarea, input/);
  });
});
