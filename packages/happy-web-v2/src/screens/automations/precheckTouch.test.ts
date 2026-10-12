/**
 * B-560 source assertions (verified with scripts/dev/mutation-check.mjs), from the
 * live-browser acceptance at 390px coarse: the detail/list header verbs go
 * icon-only under 600px and measured 31×44; the row name measured 32px tall;
 * the precheck card's cwd/timeout line wrapped after the mode and left a
 * dangling "·" at the end of the first line.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
/** the body of the (only) top-level `@media (pointer: coarse) {` block */
function coarseBlock(css: string): string {
  const start = css.indexOf('\n@media (pointer: coarse) {');
  expect(start).toBeGreaterThan(-1);
  const end = css.indexOf('\n}', start);
  return css.slice(start, end);
}

describe('B-560 automations touch targets and precheck card', () => {
  it('icon-only header verbs are at least 44px wide on a coarse pointer', () => {
    const coarse = coarseBlock(read('./automations.css'));
    expect(coarse).toMatch(/\.au-btn--icon,\n\s+\.au-header-tools \.au-btn \{[^}]*min-width: 44px;/);
  });
  it('the row name (open detail) is a 44px-tall target on a coarse pointer', () => {
    const coarse = coarseBlock(read('./automations.css'));
    expect(coarse).toMatch(/\.au-row-name \{[^}]*min-height: 44px;/);
  });
  it('precheck details render on their own line, not inline after the mode', () => {
    const src = read('./AutomationDetailScreen.tsx');
    const card = src.slice(src.indexOf('function PrecheckCard'), src.indexOf('function FireCard'));
    expect(card).toContain('<p className="mono au-precheck-details">{text.details.join(\' · \')}</p>');
    expect(card).not.toContain('au-dot');
  });
});
