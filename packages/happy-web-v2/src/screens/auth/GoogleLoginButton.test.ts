import { describe, expect, it } from 'vitest';
import {
  googleButtonTheme,
  initialGoogleButtonState,
  reduceGoogleButtonState,
  shouldShowGoogleBlock,
} from './googleButtonState';

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
});
