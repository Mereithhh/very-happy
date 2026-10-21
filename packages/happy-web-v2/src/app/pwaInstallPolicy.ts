export const PWA_INSTALL_CONFIRMED_KEY = 'vh-pwa-install-confirmed-v1';
export const PWA_INSTALL_NEVER_KEY = 'vh-pwa-install-never-v1';
/** B-681: 「暂不」/ close / Esc — epoch ms until which this device is not asked again. */
export const PWA_INSTALL_SNOOZE_KEY = 'vh-pwa-install-snoozed-until-v1';
/** A week: long enough not to nag on every reload / route change, short enough
 *  that someone who meant「not now」still hears about it. */
export const PWA_INSTALL_SNOOZE_MS = 7 * 24 * 60 * 60 * 1000;

/** Stored snooze → still snoozed? Garbage (or a value absurdly far in the future
 *  from a skewed clock) never blocks the prompt for longer than one snooze. */
export function isPwaInstallSnoozed(raw: string | null, now: number): boolean {
  if (!raw) return false;
  const until = Number(raw);
  if (!Number.isFinite(until)) return false;
  return until > now && until - now <= PWA_INSTALL_SNOOZE_MS;
}

export function pwaInstallSnoozeUntil(now: number): string {
  return String(now + PWA_INSTALL_SNOOZE_MS);
}

export type PwaInstallGuide = 'native' | 'ios-safari' | 'ios-chrome' | 'ios-other' | 'manual';
export type PwaInstallOutcome = 'accepted' | 'dismissed';

export interface DeferredPwaInstall {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: PwaInstallOutcome; platform: string }>;
}

export function shouldDeferPwaInstall(activeElement: { matches(selector: string): boolean } | null) {
  return activeElement?.matches('input, textarea, select, [contenteditable="true"]') === true;
}

export function isStandalonePwa(displayModeStandalone: boolean, navigatorStandalone: boolean | undefined) {
  return displayModeStandalone || navigatorStandalone === true;
}

export function isAppleMobile(userAgent: string, maxTouchPoints: number) {
  return /iPhone|iPad|iPod/i.test(userAgent)
    || (/Macintosh/i.test(userAgent) && maxTouchPoints > 1);
}

export function isAppleInstallGuide(guide: PwaInstallGuide) {
  return guide.startsWith('ios-');
}

export function manualInstallGuide(userAgent: string, maxTouchPoints: number): PwaInstallGuide {
  if (!isAppleMobile(userAgent, maxTouchPoints)) return 'manual';
  if (/CriOS/i.test(userAgent)) return 'ios-chrome';
  // Safari identifies itself with both Version/* and Safari/*. Other iOS
  // browsers all use WebKit too, so defaulting an unknown UA to Safari gives
  // Brave, DuckDuckGo, embedded browsers, etc. the wrong toolbar directions.
  if (/Version\/[^ ]+.*Safari\//i.test(userAgent)) return 'ios-safari';
  return 'ios-other';
}

export function canOfferPwaInstall(options: {
  isStandalone: boolean;
  installConfirmed: boolean;
  neverPrompt: boolean;
  snoozed?: boolean;
}) {
  return !options.isStandalone
    && !options.installConfirmed
    && !options.neverPrompt
    && !options.snoozed;
}

export async function requestNativePwaInstall(event: DeferredPwaInstall): Promise<PwaInstallOutcome> {
  await event.prompt();
  return (await event.userChoice).outcome;
}
