import { describe, expect, it } from 'vitest';
import {
  PWA_INSTALL_DISMISS_COOLDOWN_MS,
  canOfferPwaInstall,
  isAppleMobile,
  isInstallDismissalCoolingDown,
  isStandalonePwa,
  manualInstallGuide,
  requestNativePwaInstall,
  shouldDeferPwaInstall,
} from './pwaInstallPolicy';

describe('PWA install prompt policy', () => {
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
    expect(manualInstallGuide('Mozilla/5.0 (Linux; Android 15)', 5)).toBe('manual');
  });

  it('suppresses recently dismissed prompts but recovers after seven days', () => {
    const now = 2_000_000_000_000;
    expect(isInstallDismissalCoolingDown(String(now - 1_000), now)).toBe(true);
    expect(isInstallDismissalCoolingDown(String(now - PWA_INSTALL_DISMISS_COOLDOWN_MS), now)).toBe(false);
    expect(isInstallDismissalCoolingDown('not-a-date', now)).toBe(false);
  });

  it('offers only to eligible mobile browser sessions', () => {
    const base = { isMobile: true, isStandalone: false, installConfirmed: false, rawDismissedAt: null };
    expect(canOfferPwaInstall(base)).toBe(true);
    expect(canOfferPwaInstall({ ...base, isMobile: false })).toBe(false);
    expect(canOfferPwaInstall({ ...base, isStandalone: true })).toBe(false);
    expect(canOfferPwaInstall({ ...base, installConfirmed: true })).toBe(false);
    expect(canOfferPwaInstall({ ...base, rawDismissedAt: String(Date.now()) })).toBe(false);
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
