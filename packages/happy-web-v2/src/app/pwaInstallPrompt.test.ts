import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  canOfferPwaInstall,
  isAppleMobile,
  isAppleInstallGuide,
  isStandalonePwa,
  manualInstallGuide,
  requestNativePwaInstall,
  shouldDeferPwaInstall,
} from './pwaInstallPolicy';
import {
  clearCapturedPwaInstallPrompt,
  getCapturedPwaInstallPrompt,
  pwaInstallCaptureTestApi,
  subscribeToPwaInstallPrompt,
  type BeforeInstallPromptEvent,
} from './pwaInstallCapture';

describe('PWA install prompt policy', () => {
  const component = readFileSync(new URL('./PwaInstallPrompt.tsx', import.meta.url), 'utf8');
  it('recognizes standalone display mode and the iOS navigator flag', () => {
    expect(isStandalonePwa(true, false)).toBe(true);
    expect(isStandalonePwa(false, true)).toBe(true);
    expect(isStandalonePwa(false, undefined)).toBe(false);
  });

  it('recognizes iPhone, iPad, and touch-capable iPad desktop user agents', () => {
    expect(isAppleMobile('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)', 5)).toBe(true);
    expect(isAppleMobile('Mozilla/5.0 (iPad; CPU OS 18_0)', 5)).toBe(true);
    expect(isAppleMobile('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)', 5)).toBe(true);
    expect(isAppleMobile('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)', 0)).toBe(false);
    expect(manualInstallGuide('Mozilla/5.0 (iPhone) AppleWebKit/605.1 Version/18.0 Mobile Safari/604.1', 5)).toBe('ios-safari');
    expect(manualInstallGuide('Mozilla/5.0 (iPhone) AppleWebKit/605.1 CriOS/140.0 Mobile Safari/604.1', 5)).toBe('ios-chrome');
    expect(manualInstallGuide('Mozilla/5.0 (iPhone) AppleWebKit/605.1 FxiOS/142.0 Mobile Safari/605.1', 5)).toBe('ios-other');
    expect(manualInstallGuide('Mozilla/5.0 (iPhone) AppleWebKit/605.1 Mobile/15E148', 5)).toBe('ios-other');
    expect(manualInstallGuide('Mozilla/5.0 (Linux; Android 15)', 5)).toBe('manual');
    expect(isAppleInstallGuide('ios-safari')).toBe(true);
    expect(isAppleInstallGuide('ios-chrome')).toBe(true);
    expect(isAppleInstallGuide('ios-other')).toBe(true);
    expect(isAppleInstallGuide('manual')).toBe(false);
  });

  it('offers on every eligible browser launch until installed or explicitly disabled', () => {
    const base = { isStandalone: false, installConfirmed: false, neverPrompt: false };
    expect(canOfferPwaInstall(base)).toBe(true);
    expect(canOfferPwaInstall({ ...base, isStandalone: true })).toBe(false);
    expect(canOfferPwaInstall({ ...base, installConfirmed: true })).toBe(false);
    expect(canOfferPwaInstall({ ...base, neverPrompt: true })).toBe(false);
  });

  it('keeps a normal dismissal session-only and reserves persistence for the explicit never action', () => {
    const dismissBody = component.slice(component.indexOf('const dismiss ='), component.indexOf('const neverPrompt ='));
    expect(dismissBody).not.toContain('writeStorage');
    expect(component).toContain("writeStorage(PWA_INSTALL_NEVER_KEY, '1')");
  });

  it('lets a new browser install event recover from a stale installed marker', () => {
    expect(component).toContain('removeStorage(PWA_INSTALL_CONFIRMED_KEY)');
    expect(component).toContain('getCapturedPwaInstallPrompt()');
    expect(component).toContain('subscribeToPwaInstallPrompt(onBeforeInstallPrompt)');
  });

  it('retains an install event captured before React mounts', () => {
    pwaInstallCaptureTestApi.reset();
    const event = Object.assign(new Event('beforeinstallprompt', { cancelable: true }), {
      prompt: async () => undefined,
      userChoice: Promise.resolve({ outcome: 'accepted' as const, platform: 'web' }),
    }) as BeforeInstallPromptEvent;
    const seen: BeforeInstallPromptEvent[] = [];
    const unsubscribe = subscribeToPwaInstallPrompt((next) => seen.push(next));

    pwaInstallCaptureTestApi.capture(event);

    expect(event.defaultPrevented).toBe(true);
    expect(getCapturedPwaInstallPrompt()).toBe(event);
    expect(seen).toEqual([event]);
    clearCapturedPwaInstallPrompt(event);
    expect(getCapturedPwaInstallPrompt()).toBeNull();
    unsubscribe();
    pwaInstallCaptureTestApi.reset();
  });

  it('defers a proactive panel while the user is editing', () => {
    expect(shouldDeferPwaInstall({ matches: (selector) => selector.includes('input') })).toBe(true);
    expect(shouldDeferPwaInstall({ matches: () => false })).toBe(false);
    expect(shouldDeferPwaInstall(null)).toBe(false);
  });

  it('opens the browser-owned install UI and returns its decision', async () => {
    const calls: string[] = [];
    const outcome = await requestNativePwaInstall({
      prompt: async () => { calls.push('prompt'); },
      userChoice: Promise.resolve({ outcome: 'accepted', platform: 'web' }),
    });
    expect(calls).toEqual(['prompt']);
    expect(outcome).toBe('accepted');
  });

  it('does not disguise a rejected native prompt as an install', async () => {
    await expect(requestNativePwaInstall({
      prompt: async () => { throw new Error('browser rejected prompt'); },
      userChoice: Promise.resolve({ outcome: 'accepted', platform: 'web' }),
    })).rejects.toThrow('browser rejected prompt');
  });
});
