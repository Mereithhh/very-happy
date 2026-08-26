import { describe, expect, it } from 'vitest';
import { GOOGLE_BUTTON_MAX_WIDTH, googleButtonWidth } from './googleButtonLayout';

describe('googleButtonWidth', () => {
  it('waits for a measurable host instead of rendering a clipped 400px fallback', () => {
    expect(googleButtonWidth(0)).toBeNull();
    expect(googleButtonWidth(Number.NaN)).toBeNull();
  });

  it('uses the real narrow-screen width without imposing an artificial minimum', () => {
    expect(googleButtonWidth(184.9)).toBe(184);
    expect(googleButtonWidth(276)).toBe(276);
  });

  it('honors the GIS maximum width', () => {
    expect(googleButtonWidth(400)).toBe(GOOGLE_BUTTON_MAX_WIDTH);
    expect(googleButtonWidth(640)).toBe(GOOGLE_BUTTON_MAX_WIDTH);
  });
});
