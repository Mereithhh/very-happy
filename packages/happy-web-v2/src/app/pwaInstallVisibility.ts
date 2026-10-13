/**
 * Tiny visibility signal for the PWA install card (B-570): the notification
 * opt-in card yields while the install card is on screen, so the two never
 * stack in the same corner. Written by PwaInstallPrompt, read by
 * NotificationOptInCard.
 */
import { useSyncExternalStore } from 'react';

let visible = false;
const listeners = new Set<() => void>();

export function setPwaInstallPromptVisible(next: boolean): void {
    if (visible === next) return;
    visible = next;
    for (const fn of listeners) fn();
}

export function isPwaInstallPromptVisible(): boolean {
    return visible;
}

function subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

export function usePwaInstallPromptVisible(): boolean {
    return useSyncExternalStore(subscribe, isPwaInstallPromptVisible, isPwaInstallPromptVisible);
}
