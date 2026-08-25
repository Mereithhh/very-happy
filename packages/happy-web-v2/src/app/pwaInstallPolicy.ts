export const PWA_INSTALL_CONFIRMED_KEY = 'vh-pwa-install-confirmed-v1';
export const PWA_INSTALL_NEVER_KEY = 'vh-pwa-install-never-v1';

export type PwaInstallGuide = 'native' | 'ios' | 'manual';
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

export function manualInstallGuide(userAgent: string, maxTouchPoints: number): PwaInstallGuide {
  return isAppleMobile(userAgent, maxTouchPoints) ? 'ios' : 'manual';
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
