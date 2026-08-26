import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const baseCss = readFileSync(new URL('../styles/base.css', import.meta.url), 'utf8');

describe('mobile back button presentation', () => {
  it('does not expose touch devices to the sticky Safari hover state', () => {
    expect(baseCss).toMatch(
      /@media \(hover: hover\) and \(pointer: fine\) \{[\s\S]*?\.vh-back:hover/,
    );
    expect(baseCss).toMatch(
      /@media \(pointer: coarse\) \{[\s\S]*?\.vh-back:active/,
    );
  });

  it('marks the back control as a direct tap target', () => {
    expect(baseCss).toMatch(/\.vh-back \{[\s\S]*?touch-action: manipulation;/);
  });
});
