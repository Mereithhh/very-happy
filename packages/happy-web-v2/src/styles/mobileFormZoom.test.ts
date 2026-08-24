import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const baseCss = readFileSync(fileURLToPath(new URL('./base.css', import.meta.url)), 'utf8');

function mobileEditableBlock(css: string): string {
  const start = css.indexOf('@media (pointer: coarse), (max-width: 860px)');
  expect(start).toBeGreaterThanOrEqual(0);

  // This first coarse-pointer block is intentionally small and contains one
  // nested rule. Stop at the next top-level rule instead of bringing in the
  // unrelated typography below it.
  const end = css.indexOf('\n}\n\ncode,', start);
  expect(end).toBeGreaterThan(start);
  return css.slice(start, end + 2);
}

describe('mobile Safari editable font floor', () => {
  const rule = mobileEditableBlock(baseCss);

  it('also covers phone-width viewports when pointer reporting is not coarse', () => {
    expect(rule).toContain('@media (pointer: coarse), (max-width: 860px)');
  });

  it('covers every focusable text-editing surface with a 16px token', () => {
    expect(rule).toContain(':is(#root, body) :where(');
    expect(rule).toMatch(/\binput,/);
    expect(rule).toMatch(/\btextarea,/);
    expect(rule).toMatch(/\bselect,/);
    expect(rule).toContain("[contenteditable]:not([contenteditable='false' i])");
    expect(rule).toContain('font-size: var(--fs-16);');
  });

  it('uses root specificity so later component classes cannot lower the floor', () => {
    // `:is()` adopts the specificity of its strongest branch (`#root`) even
    // when the element lives in the body branch (a React portal).
    expect(rule).toContain(':is(#root, body) :where(');
    expect(rule).not.toContain('!important');
  });

  it('carves terminal-owned inputs out of the generic form rule', () => {
    expect(rule).toContain(':not(:where(.xterm, .xterm *))');
  });

  it('gives the focused xterm helper its own iOS-safe floor', () => {
    expect(rule).toContain(':is(#root, body) .xterm .xterm-helper-textarea {');
    const helperRule = rule.slice(rule.indexOf(':is(#root, body) .xterm .xterm-helper-textarea {'));
    expect(helperRule).toContain('font-size: var(--fs-16);');
    expect(helperRule).not.toContain('!important');
  });
});
