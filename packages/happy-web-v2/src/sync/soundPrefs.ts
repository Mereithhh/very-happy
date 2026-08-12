/**
 * soundPrefs — device-local preferences for the notification chime (WebAudio,
 * see utils/chimes.ts). Modeled on notificationPrefs.ts: a dedicated MMKV
 * instance, never synced — speakers/volume are properties of THIS device.
 *
 * Independent of the browser-Notification prefs on purpose: the chime needs
 * no OS permission, so it defaults ON (the whole point of the notification
 * system is "you must hear when the agent needs you"). It still respects the
 * shared quiet-hours window (enforced by notificationChime.ts, not here).
 */

import { MMKV } from '@/storage/mmkv-web';
import * as React from 'react';
import type { ChimeVoice } from '@/utils/chimes';
import { CHIME_VOICES } from '@/utils/chimes';
import type { SoundEvent } from './notificationInbox';

const store = new MMKV({ id: 'notification-sound-prefs' });
const KEY = 'sound-prefs';

export interface SoundPrefs {
    /** master switch for the chime */
    enabled: boolean;
    /** 0..1 */
    volume: number;
    voice: ChimeVoice;
    /** per-event-category opt-out (权限请求 / 提问 / 完成) */
    events: Record<SoundEvent, boolean>;
}

export const DEFAULT_SOUND_PREFS: SoundPrefs = {
    enabled: true,
    volume: 0.6,
    voice: 'duo',
    events: {
        permission: true,
        question: true,
        done: true,
    },
};

function clamp01(v: unknown): number | null {
    if (typeof v !== 'number' || !Number.isFinite(v)) return null;
    return Math.min(1, Math.max(0, v));
}

function parsePrefs(raw: string | undefined): SoundPrefs {
    if (!raw) return { ...DEFAULT_SOUND_PREFS };
    try {
        const obj = JSON.parse(raw);
        const ev = obj?.events ?? {};
        return {
            enabled: typeof obj?.enabled === 'boolean' ? obj.enabled : DEFAULT_SOUND_PREFS.enabled,
            volume: clamp01(obj?.volume) ?? DEFAULT_SOUND_PREFS.volume,
            voice: CHIME_VOICES.includes(obj?.voice) ? obj.voice : DEFAULT_SOUND_PREFS.voice,
            events: {
                permission: typeof ev.permission === 'boolean' ? ev.permission : DEFAULT_SOUND_PREFS.events.permission,
                question: typeof ev.question === 'boolean' ? ev.question : DEFAULT_SOUND_PREFS.events.question,
                done: typeof ev.done === 'boolean' ? ev.done : DEFAULT_SOUND_PREFS.events.done,
            },
        };
    } catch {
        return { ...DEFAULT_SOUND_PREFS };
    }
}

// Stable snapshot cache for useSyncExternalStore (see notificationPrefs.ts).
let cachedRaw: string | undefined | null = null; // null = never read
let cachedPrefs: SoundPrefs = DEFAULT_SOUND_PREFS;

export function getSoundPrefs(): SoundPrefs {
    const raw = store.getString(KEY);
    if (raw !== cachedRaw) {
        cachedRaw = raw;
        cachedPrefs = parsePrefs(raw);
    }
    return cachedPrefs;
}

const listeners = new Set<() => void>();
function emit() {
    for (const l of listeners) l();
}

export function setSoundPrefs(next: SoundPrefs): void {
    const raw = JSON.stringify(next);
    store.set(KEY, raw);
    cachedRaw = raw;
    cachedPrefs = next;
    emit();
}

export function updateSoundPrefs(delta: Partial<SoundPrefs>): SoundPrefs {
    const next = { ...getSoundPrefs(), ...delta } as SoundPrefs;
    setSoundPrefs(next);
    return next;
}

export function setSoundEventEnabled(event: SoundEvent, value: boolean): void {
    const cur = getSoundPrefs();
    setSoundPrefs({ ...cur, events: { ...cur.events, [event]: value } });
}

function subscribe(cb: () => void): () => void {
    listeners.add(cb);
    return () => {
        listeners.delete(cb);
    };
}

export function useSoundPrefs(): SoundPrefs {
    return React.useSyncExternalStore(subscribe, getSoundPrefs, getSoundPrefs);
}
