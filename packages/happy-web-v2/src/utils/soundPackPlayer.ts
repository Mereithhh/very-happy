/**
 * soundPackPlayer — plays an OpenPeon pack clip for a notification (B-469).
 *
 * Runtime half of sync/soundPacks.ts. A pack is fetched from its own host on
 * first use (manifest + the clip about to play), decoded through the same
 * AudioContext the synthesized chimes use (so the autoplay unlock is shared),
 * and kept in memory plus the Cache API (`vh-sound-packs-v1`) so later plays
 * — and offline ones — never hit the network again. Every failure resolves
 * to 'unavailable' and the caller falls back to the chime: a missing network
 * must never turn a notification silent.
 */
import { getAudioContext, playDecodedBuffer } from './chimes';
import {
    clipsForEvent,
    parseSoundPackManifest,
    pickClip,
    soundPackFileUrl,
    soundPackManifestUrl,
    type SoundPackManifest,
} from '@/sync/soundPacks';
import type { SoundEvent } from '@/sync/notificationInbox';

const CACHE_NAME = 'vh-sound-packs-v1';
const FETCH_TIMEOUT_MS = 8_000;

const manifests = new Map<string, Promise<SoundPackManifest | null>>();
const buffers = new Map<string, Promise<AudioBuffer | null>>();
const lastFileByKey = new Map<string, string>();

async function cachedFetch(url: string): Promise<Response | null> {
    let cache: Cache | null = null;
    try {
        if (typeof caches !== 'undefined') cache = await caches.open(CACHE_NAME);
    } catch {
        cache = null;
    }
    if (cache) {
        try {
            const hit = await cache.match(url);
            if (hit) return hit;
        } catch {
            // fall through to the network
        }
    }
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS) : null;
    try {
        const res = await fetch(url, { signal: controller?.signal, mode: 'cors', credentials: 'omit' });
        if (!res.ok) return null;
        if (cache) {
            try { await cache.put(url, res.clone()); } catch { /* quota / opaque — ignore */ }
        }
        return res;
    } catch {
        return null;
    } finally {
        if (timer) clearTimeout(timer);
    }
}

export function loadSoundPackManifest(packId: string): Promise<SoundPackManifest | null> {
    let pending = manifests.get(packId);
    if (!pending) {
        pending = (async () => {
            const res = await cachedFetch(soundPackManifestUrl(packId));
            if (!res) return null;
            try {
                return parseSoundPackManifest(packId, await res.json());
            } catch {
                return null;
            }
        })();
        manifests.set(packId, pending);
        // A failed load is not cached as a verdict: the next play retries.
        void pending.then((m) => { if (!m) manifests.delete(packId); });
    }
    return pending;
}

function loadClip(packId: string, file: string): Promise<AudioBuffer | null> {
    const url = soundPackFileUrl(packId, file);
    if (!url) return Promise.resolve(null);
    let pending = buffers.get(url);
    if (!pending) {
        pending = (async () => {
            const ctx = getAudioContext();
            const res = await cachedFetch(url);
            if (!ctx || !res) return null;
            try {
                return await ctx.decodeAudioData(await res.arrayBuffer());
            } catch {
                return null;
            }
        })();
        buffers.set(url, pending);
        void pending.then((b) => { if (!b) buffers.delete(url); });
    }
    return pending;
}

export type PackPlayOutcome = 'played' | 'unavailable';

/**
 * Play one line of `packId` for `event`. Resolves 'unavailable' when the
 * pack, the clip, WebAudio or the network is missing — never throws.
 */
export async function playPackSound(
    packId: string,
    event: SoundEvent,
    volume: number,
    opts?: { error?: boolean },
): Promise<PackPlayOutcome> {
    try {
        const manifest = await loadSoundPackManifest(packId);
        if (!manifest) return 'unavailable';
        const clips = clipsForEvent(manifest, event, opts);
        const key = `${packId}:${event}`;
        const clip = pickClip(clips, lastFileByKey.get(key) ?? null);
        if (!clip) return 'unavailable';
        lastFileByKey.set(key, clip.file);
        const buffer = await loadClip(packId, clip.file);
        if (!buffer) return 'unavailable';
        return playDecodedBuffer(buffer, volume) ? 'played' : 'unavailable';
    } catch {
        return 'unavailable';
    }
}

/** Warm the manifest and the three event clips so the first real
 *  notification does not wait on the network. Best-effort. */
export async function preloadSoundPack(packId: string): Promise<boolean> {
    const manifest = await loadSoundPackManifest(packId);
    if (!manifest) return false;
    const files = new Set<string>();
    for (const event of ['permission', 'question', 'done'] as const) {
        for (const clip of clipsForEvent(manifest, event)) files.add(clip.file);
    }
    const results = await Promise.all([...files].slice(0, 24).map((file) => loadClip(packId, file)));
    return results.some(Boolean);
}
