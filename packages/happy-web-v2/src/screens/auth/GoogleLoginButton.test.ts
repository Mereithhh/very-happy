import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  googleButtonTheme,
  initialGoogleButtonState,
  reduceGoogleButtonState,
  shouldShowGoogleBlock,
} from './googleButtonState';

const component = readFileSync(new URL('./GoogleLoginButton.tsx', import.meta.url), 'utf8');
const styles = readFileSync(new URL('./auth.css', import.meta.url), 'utf8');

describe('GoogleLoginButton required-state transitions', () => {
  it('starts in a visible loading state and exposes failure instead of going blank', () => {
    expect(initialGoogleButtonState).toEqual({ enabled: false, failed: false, attempt: 0 });

    const unavailable = reduceGoogleButtonState(initialGoogleButtonState, 'unavailable');
    expect(unavailable).toEqual({ enabled: false, failed: true, attempt: 0 });
  });

  it('Retry restores loading and advances the attempt that reloads provider config', () => {
    const unavailable = reduceGoogleButtonState(initialGoogleButtonState, 'unavailable');
    const retrying = reduceGoogleButtonState(unavailable, 'retry');
    expect(retrying).toEqual({ enabled: false, failed: false, attempt: 1 });

    expect(reduceGoogleButtonState(retrying, 'rendering')).toEqual(retrying);
    expect(reduceGoogleButtonState(retrying, 'rendered')).toEqual({
      enabled: true,
      failed: false,
      attempt: 1,
    });
  });

  it('reserves the provider slot while config is checked and while an existing iframe refreshes', () => {
    expect(shouldShowGoogleBlock('checking', false, false)).toBe(true);
    expect(shouldShowGoogleBlock('configured', false, false)).toBe(true);
    expect(shouldShowGoogleBlock('absent', false, false)).toBe(false);

    const rendered = reduceGoogleButtonState(initialGoogleButtonState, 'rendered');
    expect(reduceGoogleButtonState(rendered, 'rendering')).toEqual(rendered);
  });

  it('uses the current GIS dark theme instead of the white-tile filled-black theme', () => {
    expect(googleButtonTheme('dark')).toBe('outline_dark');
    expect(googleButtonTheme('light')).toBe('outline');
  });

  it('keeps the GIS host measurable while loading and rerenders it on host resize', () => {
    expect(styles).toContain('.auth-google-block.is-loading .auth-google { visibility: hidden; }');
    expect(styles).not.toMatch(/\.auth-google iframe \{[\s\S]*width: 100% !important/);
    expect(component).toContain('new ResizeObserver');
    expect(component).toContain('googleButtonWidth(containerRef.current.clientWidth)');
  });
});
