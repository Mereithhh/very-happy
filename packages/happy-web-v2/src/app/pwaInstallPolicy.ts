export const PWA_INSTALL_DISMISSED_AT_KEY = 'vh-pwa-install-dismissed-at-v1';
export const PWA_INSTALL_CONFIRMED_KEY = 'vh-pwa-install-confirmed-v1';
export const PWA_INSTALL_DISMISS_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1_000;

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

export function isInstallDismissalCoolingDown(rawDismissedAt: string | null, now = Date.now()) {
  if (!rawDismissedAt) return false;
  const dismissedAt = Number(rawDismissedAt);
  if (!Number.isFinite(dismissedAt) || dismissedAt <= 0) return false;
  return now - dismissedAt < PWA_INSTALL_DISMISS_COOLDOWN_MS;
}

export function canOfferPwaInstall(options: {
  isMobile: boolean;
  isStandalone: boolean;
  installConfirmed: boolean;
  rawDismissedAt: string | null;
  now?: number;
}) {
  return options.isMobile
    && !options.isStandalone
    && !options.installConfirmed
    && !isInstallDismissalCoolingDown(options.rawDismissedAt, options.now);
}

export async function requestNativePwaInstall(event: DeferredPwaInstall): Promise<PwaInstallOutcome> {
  await event.prompt();
  return (await event.userChoice).outcome;
}
