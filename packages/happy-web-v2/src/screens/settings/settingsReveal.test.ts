import { describe, expect, it } from 'vitest';
import { revealTop } from './settingsReveal';

describe('revealTop (B-575)', () => {
  const base = { containerTop: 100, containerScrollTop: 0, containerClientHeight: 500, containerScrollHeight: 2000 };

  it('puts the target top a margin below the container top', () => {
    expect(revealTop({ ...base, targetTop: 900 })).toBe(900 - 100 - 16);
    expect(revealTop({ ...base, containerScrollTop: 300, targetTop: 400 })).toBe(300 + 300 - 16);
  });

  it('clamps to the scrollable range', () => {
    expect(revealTop({ ...base, targetTop: 105 })).toBe(0);
    expect(revealTop({ ...base, targetTop: 5000 })).toBe(1500);
    expect(revealTop({ ...base, containerScrollHeight: 300, targetTop: 900 })).toBe(0);
  });
});
