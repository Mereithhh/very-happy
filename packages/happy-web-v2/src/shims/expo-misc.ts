/**
 * Web shims for assorted expo native modules the data layer touches for version /
 * device info / app lifecycle. Each is aliased individually in vite.config.ts via
 * a `?module=` query so one file serves several modules.
 */

// expo-application
export const nativeApplicationVersion: string | null = __APP_VERSION__;
export const nativeBuildVersion: string | null = __APP_VERSION__;
export const applicationName: string | null = 'Very Happy';

// expo-device
export const deviceName: string | null =
  typeof navigator !== 'undefined' ? 'Browser' : null;
export const isDevice = true;
export const modelName: string | null = 'Web';
export const osName: string | null = 'Web';
export const osVersion: string | null =
  typeof navigator !== 'undefined' ? navigator.userAgent : null;

// expo-updates (no OTA on web)
export async function reloadAsync(): Promise<void> {
  if (typeof window !== 'undefined') window.location.reload();
}
export function clear(): void {}
export function bind(): { remove: () => void } {
  return { remove() {} };
}
export const isEnabled = false;
export const updateId: string | null = null;
export const runtimeVersion: string | null = __APP_VERSION__;
export const channel: string | null = null;
export const createdAt: Date | null = null;
