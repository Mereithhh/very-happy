import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('input modality wiring (B-728)', () => {
  it('base.css silences --focus-ring in pointer modality and is installed from main.tsx', () => {
    const base = readFileSync(new URL('../styles/base.css', import.meta.url), 'utf8');
    expect(base).toMatch(/:root\[data-input=['"]?pointer['"]?\]\s*\{[^}]*--focus-ring:\s*0 0 0 0 transparent/);
    const main = readFileSync(new URL('../main.tsx', import.meta.url), 'utf8');
    expect(main).toMatch(/installInputModality\(\)/);
  });
});
