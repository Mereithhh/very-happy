/**
 * soundPacks — PURE model for OpenPeon / peon-ping sound packs (B-469).
 *
 * peon-ping (github.com/PeonPing/peon-ping) plays game voice lines on coding
 * events; its official packs live in github.com/PeonPing/og-packs, one
 * `openpeon.json` manifest (CESP v1.0) + a `sounds/` directory each. The
 * clips are game audio (Blizzard, EA, Valve…) distributed by that project
 * under CC-BY-NC-4.0 / fair use for personal notification — so very-happy
 * never bundles them: the browser fetches a pack from its own host on first
 * use (raw.githubusercontent.com answers with `access-control-allow-origin:
 * *`) and keeps it in the Cache API. Nothing here touches the network; the
 * player (utils/soundPackPlayer.ts) does.
 *
 * Mapping to very-happy's three sound events (notificationInbox.SoundEvent):
 *   permission → input.required   (a tool asks; "Yes, sir?")
 *   question   → input.required   (input needed / review / blocked / error)
 *   done       → task.complete    ("Reporting.")
 * `task.error` is used for `question` when the pack has it and the caller
 * says the underlying category was an error — the inbox folds error into
 * question, so the sound picks the sharper line where one exists.
 */
import type { SoundEvent } from './notificationInbox';

export const SOUND_PACK_HOST = 'https://raw.githubusercontent.com/PeonPing/og-packs/main';

export type CespCategory =
    | 'session.start' | 'task.acknowledge' | 'task.complete' | 'task.error'
    | 'input.required' | 'resource.limit' | 'user.spam' | 'session.end' | 'task.progress';

export interface SoundPackInfo {
    id: string;
    /** Character / voice */
    name: string;
    franchise: string;
    /** BCP-47-ish, as og-packs lists it */
    language: string;
}

/** The og-packs collection (README of PeonPing/og-packs, 2026-09). Red Alert
 *  first — the request that brought this here — then by franchise. */
export const SOUND_PACKS: readonly SoundPackInfo[] = [
    { id: 'ra_soviet', name: 'Soviet Soldier', franchise: 'Red Alert', language: 'en' },
    { id: 'ra2_kirov', name: 'Kirov Airship', franchise: 'Red Alert 2', language: 'en' },
    { id: 'ra2_soviet_engineer', name: 'Soviet Engineer', franchise: 'Red Alert 2', language: 'en' },
    { id: 'peon', name: 'Orc Peon', franchise: 'Warcraft III', language: 'en' },
    { id: 'peasant', name: 'Human Peasant', franchise: 'Warcraft III', language: 'en' },
    { id: 'wc3_grunt', name: 'Orc Grunt', franchise: 'Warcraft III', language: 'en' },
    { id: 'wc3_knight', name: 'Human Knight', franchise: 'Warcraft III', language: 'en' },
    { id: 'wc3_farseer', name: 'Far Seer', franchise: 'Warcraft III', language: 'en' },
    { id: 'wc3_brewmaster', name: 'Pandaren Brewmaster', franchise: 'Warcraft III', language: 'en' },
    { id: 'murloc', name: 'Murloc', franchise: 'Warcraft III', language: 'en' },
    { id: 'wc2_peasant', name: 'Human Peasant', franchise: 'Warcraft II', language: 'en' },
    { id: 'goblin', name: 'Goblin Merchant', franchise: 'World of Warcraft', language: 'en' },
    { id: 'sc_terran', name: 'Terran Units Mix', franchise: 'StarCraft', language: 'en' },
    { id: 'sc_kerrigan', name: 'Sarah Kerrigan', franchise: 'StarCraft', language: 'en' },
    { id: 'sc_battlecruiser', name: 'Battlecruiser', franchise: 'StarCraft', language: 'en' },
    { id: 'sc_scv', name: 'SCV', franchise: 'StarCraft', language: 'en' },
    { id: 'sc_marine', name: 'Marine', franchise: 'StarCraft', language: 'en' },
    { id: 'sc_firebat', name: 'Firebat', franchise: 'StarCraft', language: 'en' },
    { id: 'sc_medic', name: 'Medic', franchise: 'StarCraft', language: 'en' },
    { id: 'sc_tank', name: 'Siege Tank', franchise: 'StarCraft', language: 'en' },
    { id: 'sc_vessel', name: 'Science Vessel', franchise: 'StarCraft', language: 'en' },
    { id: 'glados', name: 'GLaDOS', franchise: 'Portal', language: 'en' },
    { id: 'tf2_engineer', name: 'Engineer', franchise: 'Team Fortress 2', language: 'en' },
    { id: 'cs16', name: 'Radio', franchise: 'Counter-Strike 1.6', language: 'en' },
    { id: 'dota2_axe', name: 'Axe', franchise: 'Dota 2', language: 'en' },
    { id: 'league_of_legends', name: 'Announcer', franchise: 'League of Legends', language: 'en' },
    { id: 'hd2_helldiver', name: 'Helldiver', franchise: 'Helldivers 2', language: 'en' },
    { id: 'duke_nukem', name: 'Duke Nukem', franchise: 'Duke Nukem', language: 'en' },
    { id: 'aoe2', name: 'Taunts', franchise: 'Age of Empires II', language: 'en' },
    { id: 'aom_greek', name: 'Greek Villager', franchise: 'Age of Mythology', language: 'el' },
    { id: 'molag_bal', name: 'Molag Bal', franchise: 'The Elder Scrolls', language: 'en' },
    { id: 'sheogorath', name: 'Sheogorath', franchise: 'The Elder Scrolls', language: 'en' },
    { id: 'ocarina_of_time', name: 'Navi', franchise: 'The Legend of Zelda', language: 'en' },
    { id: 'rick', name: 'Rick Sanchez', franchise: 'Rick and Morty', language: 'en' },
    { id: 'sopranos', name: 'Tony Soprano', franchise: 'The Sopranos', language: 'en' },
    { id: 'pulp_fiction', name: 'Pulp Fiction', franchise: 'Pulp Fiction', language: 'en' },
    { id: 'seinfeld_kramer', name: 'Kramer', franchise: 'Seinfeld', language: 'en' },
    { id: 'clean_chimes', name: 'Clean Chimes', franchise: 'UI sounds', language: 'en' },
    { id: 'peon_es', name: 'Orc Peon', franchise: 'Warcraft III', language: 'es' },
    { id: 'peon_fr', name: 'Orc Peon', franchise: 'Warcraft III', language: 'fr' },
    { id: 'peon_de', name: 'Orc Peon', franchise: 'Warcraft III', language: 'de' },
    { id: 'peon_ru', name: 'Orc Peon', franchise: 'Warcraft III', language: 'ru' },
    { id: 'peon_pl', name: 'Orc Peon', franchise: 'Warcraft III', language: 'pl' },
    { id: 'peon_cz', name: 'Orc Peon', franchise: 'Warcraft III', language: 'cs' },
    { id: 'peasant_es', name: 'Human Peasant', franchise: 'Warcraft III', language: 'es' },
    { id: 'peasant_fr', name: 'Human Peasant', franchise: 'Warcraft III', language: 'fr' },
    { id: 'peasant_ru', name: 'Human Peasant', franchise: 'Warcraft III', language: 'ru' },
    { id: 'peasant_cz', name: 'Human Peasant', franchise: 'Warcraft III', language: 'cs' },
    { id: 'acolyte_de', name: 'Undead Acolyte', franchise: 'Warcraft III', language: 'de' },
    { id: 'acolyte_ru', name: 'Undead Acolyte', franchise: 'Warcraft III', language: 'ru' },
    { id: 'brewmaster_ru', name: 'Pandaren Brewmaster', franchise: 'Warcraft III', language: 'ru' },
];

const PACK_ID_RE = /^[a-z0-9_]{1,40}$/;

/** A pack id we know; anything else (typo, a pack that left the registry) is
 *  null so prefs fall back to the synthesized chime. */
export function normalizeSoundPackId(raw: unknown): string | null {
    if (typeof raw !== 'string' || !PACK_ID_RE.test(raw)) return null;
    return SOUND_PACKS.some((p) => p.id === raw) ? raw : null;
}

export function soundPackInfo(id: string): SoundPackInfo | undefined {
    return SOUND_PACKS.find((p) => p.id === id);
}

export function soundPackManifestUrl(id: string): string {
    return `${SOUND_PACK_HOST}/${id}/openpeon.json`;
}

/** `file` is manifest-relative (`sounds/Foo.wav`). Path-traversal and
 *  absolute URLs are refused: a manifest is remote data, not code. */
export function soundPackFileUrl(id: string, file: string): string | null {
    if (!/^sounds\/[A-Za-z0-9._-]+$/.test(file)) return null;
    return `${SOUND_PACK_HOST}/${id}/${file}`;
}

export interface SoundPackClip {
    file: string;
    label: string;
}

export interface SoundPackManifest {
    id: string;
    displayName: string;
    license?: string;
    author?: string;
    categories: Partial<Record<CespCategory, SoundPackClip[]>>;
}

/** Tolerant parse of an `openpeon.json`: keeps only well-formed clips whose
 *  file path is one we would fetch. Returns null when nothing usable. */
export function parseSoundPackManifest(id: string, raw: unknown): SoundPackManifest | null {
    if (!raw || typeof raw !== 'object') return null;
    const m = raw as Record<string, unknown>;
    const cats = (m.categories && typeof m.categories === 'object') ? m.categories as Record<string, unknown> : {};
    const categories: SoundPackManifest['categories'] = {};
    let total = 0;
    for (const [cat, value] of Object.entries(cats)) {
        const list = (value as { sounds?: unknown } | null)?.sounds;
        if (!Array.isArray(list)) continue;
        const clips: SoundPackClip[] = [];
        for (const s of list) {
            const file = (s as { file?: unknown } | null)?.file;
            const label = (s as { label?: unknown } | null)?.label;
            if (typeof file !== 'string' || !soundPackFileUrl(id, file)) continue;
            clips.push({ file, label: typeof label === 'string' ? label : '' });
        }
        if (clips.length > 0) {
            categories[cat as CespCategory] = clips;
            total += clips.length;
        }
    }
    if (total === 0) return null;
    const author = (m.author as { name?: unknown } | null)?.name;
    return {
        id,
        displayName: typeof m.display_name === 'string' && m.display_name ? m.display_name : id,
        ...(typeof m.license === 'string' && m.license ? { license: m.license } : {}),
        ...(typeof author === 'string' && author ? { author } : {}),
        categories,
    };
}

/** CESP categories to try for a very-happy sound event, most specific first. */
export function cespCategoriesFor(event: SoundEvent, opts?: { error?: boolean }): CespCategory[] {
    switch (event) {
        case 'permission': return ['input.required', 'task.acknowledge', 'session.start'];
        case 'question': return opts?.error
            ? ['task.error', 'input.required', 'session.start']
            : ['input.required', 'task.error', 'session.start'];
        case 'done': return ['task.complete', 'session.start', 'task.acknowledge'];
    }
}

/** The clips a pack offers for an event (first category with any clips). */
export function clipsForEvent(manifest: SoundPackManifest, event: SoundEvent, opts?: { error?: boolean }): SoundPackClip[] {
    for (const cat of cespCategoriesFor(event, opts)) {
        const clips = manifest.categories[cat];
        if (clips && clips.length > 0) return clips;
    }
    return [];
}

/** peon-ping's rule: random, but never the same line twice in a row when
 *  there is a choice. `random` is injectable for tests. */
export function pickClip(clips: readonly SoundPackClip[], lastFile: string | null, random: () => number = Math.random): SoundPackClip | null {
    if (clips.length === 0) return null;
    const pool = clips.length > 1 && lastFile ? clips.filter((c) => c.file !== lastFile) : clips;
    const index = Math.min(pool.length - 1, Math.max(0, Math.floor(random() * pool.length)));
    return pool[index];
}
