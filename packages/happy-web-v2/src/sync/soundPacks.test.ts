import { describe, expect, it } from 'vitest';
import {
    SOUND_PACKS,
    cespCategoriesFor,
    clipsForEvent,
    normalizeSoundPackId,
    parseSoundPackManifest,
    pickClip,
    soundPackFileUrl,
    soundPackManifestUrl,
} from './soundPacks';

describe('B-469 sound packs (OpenPeon / peon-ping)', () => {
    it('catalog ids are unique, well-formed, and Red Alert comes first', () => {
        const ids = SOUND_PACKS.map((p) => p.id);
        expect(new Set(ids).size).toBe(ids.length);
        for (const id of ids) expect(id).toMatch(/^[a-z0-9_]+$/);
        expect(ids.slice(0, 3)).toEqual(['ra_soviet', 'ra2_kirov', 'ra2_soviet_engineer']);
        expect(normalizeSoundPackId('ra_soviet')).toBe('ra_soviet');
        expect(normalizeSoundPackId('RA_SOVIET')).toBeNull();
        expect(normalizeSoundPackId('../etc')).toBeNull();
        expect(normalizeSoundPackId(42)).toBeNull();
        expect(normalizeSoundPackId('not_a_pack')).toBeNull();
    });

    it('builds urls only for manifest-relative sound files', () => {
        expect(soundPackManifestUrl('ra_soviet')).toBe('https://raw.githubusercontent.com/PeonPing/og-packs/main/ra_soviet/openpeon.json');
        expect(soundPackFileUrl('ra_soviet', 'sounds/SovietYesSir.wav')).toBe('https://raw.githubusercontent.com/PeonPing/og-packs/main/ra_soviet/sounds/SovietYesSir.wav');
        expect(soundPackFileUrl('ra_soviet', '../peon/sounds/x.wav')).toBeNull();
        expect(soundPackFileUrl('ra_soviet', 'https://evil/x.wav')).toBeNull();
        expect(soundPackFileUrl('ra_soviet', 'sounds/sub/x.wav')).toBeNull();
    });

    it('parses a CESP manifest tolerantly (real ra_soviet shape) and drops bad clips', () => {
        const manifest = parseSoundPackManifest('ra_soviet', {
            cesp_version: '1.0', name: 'ra_soviet', display_name: 'Red Alert Soviet Soldier', license: 'CC-BY-NC-4.0',
            author: { name: 'JairusKhan' },
            categories: {
                'input.required': { sounds: [{ file: 'sounds/SovietYesSir.wav', label: 'Yes, sir?', sha256: 'x' }, { file: '../x.wav', label: 'bad' }, { label: 'no file' }] },
                'task.complete': { sounds: [{ file: 'sounds/SovietReporting.wav' }] },
                'task.error': { sounds: [] },
                'bogus': 'nope',
            },
        });
        expect(manifest).toEqual({
            id: 'ra_soviet', displayName: 'Red Alert Soviet Soldier', license: 'CC-BY-NC-4.0', author: 'JairusKhan',
            categories: {
                'input.required': [{ file: 'sounds/SovietYesSir.wav', label: 'Yes, sir?' }],
                'task.complete': [{ file: 'sounds/SovietReporting.wav', label: '' }],
            },
        });
        expect(parseSoundPackManifest('x', null)).toBeNull();
        expect(parseSoundPackManifest('x', { categories: { 'task.complete': { sounds: [{ file: 'nope' }] } } })).toBeNull();
    });

    it('maps the three very-happy events onto CESP categories with fallbacks', () => {
        expect(cespCategoriesFor('permission')[0]).toBe('input.required');
        expect(cespCategoriesFor('done')[0]).toBe('task.complete');
        expect(cespCategoriesFor('question')[0]).toBe('input.required');
        expect(cespCategoriesFor('question', { error: true })[0]).toBe('task.error');
        const manifest = parseSoundPackManifest('p', { categories: {
            'session.start': { sounds: [{ file: 'sounds/hi.wav', label: 'hi' }] },
            'task.error': { sounds: [{ file: 'sounds/err.wav', label: 'err' }] },
        } })!;
        expect(clipsForEvent(manifest, 'done').map((c) => c.file)).toEqual(['sounds/hi.wav']);      // no task.complete → session.start
        expect(clipsForEvent(manifest, 'question').map((c) => c.file)).toEqual(['sounds/err.wav']);   // no input.required → task.error
        expect(clipsForEvent(manifest, 'permission').map((c) => c.file)).toEqual(['sounds/hi.wav']);
    });

    it('picks randomly but never repeats the previous line when there is a choice', () => {
        const clips = [{ file: 'a', label: '' }, { file: 'b', label: '' }, { file: 'c', label: '' }];
        expect(pickClip(clips, 'a', () => 0)?.file).toBe('b');
        expect(pickClip(clips, 'a', () => 0.99)?.file).toBe('c');
        expect(pickClip(clips, null, () => 0)?.file).toBe('a');
        expect(pickClip([clips[0]], 'a', () => 0.5)?.file).toBe('a'); // only one line: repeat is fine
        expect(pickClip([], null)).toBeNull();
    });
});
