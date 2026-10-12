/**
 * Pending "the user should get this file" intent from an `open_preview`
 * push with `download: true` (B-562, `specs/2026-10-file-download-delivery.md` D3).
 *
 * Why a store instead of a prop/URL param: a pushed preview usually docks into
 * the session's FilesPanel via `?pinFile=` (B-539), and FilesPanel /
 * WebTerminalScreen are owned by other work. The overlay records the intent
 * here before docking; whichever FsFileViewer mounts for the same
 * (machineId, path) consumes it. One slot, newest wins, short TTL so a stale
 * intent never resurfaces when the user later opens the file by hand.
 */
import { useSyncExternalStore } from 'react';

export const DOWNLOAD_INTENT_TTL_MS = 2 * 60_000;

export interface DownloadIntent {
    machineId: string;
    path: string;
    /** Start the download without a click (desktop gate, decided at push time). */
    auto: boolean;
    at: number;
}

let current: DownloadIntent | null = null;
const listeners = new Set<() => void>();

function emit() { for (const listener of listeners) listener(); }

export function setDownloadIntent(intent: Omit<DownloadIntent, 'at'>, now = Date.now()): void {
    current = { ...intent, at: now };
    emit();
}

/** The live intent for this file, or null (other file, none, or expired). */
export function matchDownloadIntent(intent: DownloadIntent | null, machineId: string, path: string, now = Date.now()): DownloadIntent | null {
    if (!intent || intent.machineId !== machineId || intent.path !== path) return null;
    return now - intent.at <= DOWNLOAD_INTENT_TTL_MS ? intent : null;
}

/** Remove the intent if it is still this one (a newer push is left alone). */
export function consumeDownloadIntent(intent: DownloadIntent): void {
    if (current !== intent) return;
    current = null;
    emit();
}

export function peekDownloadIntent(): DownloadIntent | null {
    return current;
}

function subscribe(listener: () => void) {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

export function useDownloadIntent(machineId: string, path: string): DownloadIntent | null {
    const intent = useSyncExternalStore(subscribe, peekDownloadIntent, () => null);
    return matchDownloadIntent(intent, machineId, path);
}
