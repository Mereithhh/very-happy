import type { DeferredPwaInstall } from './pwaInstallPolicy';

export type BeforeInstallPromptEvent = Event & DeferredPwaInstall;

type InstallPromptListener = (event: BeforeInstallPromptEvent) => void;

let capturedPrompt: BeforeInstallPromptEvent | null = null;
const listeners = new Set<InstallPromptListener>();
let captureInstalled = false;

function capture(event: Event) {
  const installPrompt = event as BeforeInstallPromptEvent;
  installPrompt.preventDefault();
  capturedPrompt = installPrompt;
  listeners.forEach((listener) => listener(installPrompt));
}

/**
 * Install this before either React root is loaded. Chrome can dispatch
 * `beforeinstallprompt` while the application chunks are still downloading;
 * a component-owned listener would permanently miss that one-shot event.
 */
export function installPwaPromptCapture() {
  if (captureInstalled || typeof window === 'undefined') return;
  captureInstalled = true;
  window.addEventListener('beforeinstallprompt', capture);
}

export function getCapturedPwaInstallPrompt() {
  return capturedPrompt;
}

export function subscribeToPwaInstallPrompt(listener: InstallPromptListener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function clearCapturedPwaInstallPrompt(event?: BeforeInstallPromptEvent) {
  if (!event || capturedPrompt === event) capturedPrompt = null;
}

export const pwaInstallCaptureTestApi = {
  capture,
  reset() {
    capturedPrompt = null;
    listeners.clear();
  },
};
