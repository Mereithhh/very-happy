export const PWA_INSTALL_CONFIRMED_KEY = 'vh-pwa-install-confirmed-v1';
export const PWA_INSTALL_NEVER_KEY = 'vh-pwa-install-never-v1';

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
}) {
  return !options.isStandalone
    && !options.installConfirmed
    && !options.neverPrompt;
}

export async function requestNativePwaInstall(event: DeferredPwaInstall): Promise<PwaInstallOutcome> {
  await event.prompt();
  return (await event.userChoice).outcome;
}
