import { describe, expect, it } from 'vitest';
import { DOWNLOAD_INTENT_TTL_MS, consumeDownloadIntent, matchDownloadIntent, peekDownloadIntent, setDownloadIntent } from './downloadIntent';

describe('B-562 download intent store', () => {
    it('matches only the same machine + path within the TTL', () => {
        setDownloadIntent({ machineId: 'm', path: '/a.zip', auto: true }, 1000);
        const intent = peekDownloadIntent()!;
        expect(matchDownloadIntent(intent, 'm', '/a.zip', 1000)).toBe(intent);
        expect(matchDownloadIntent(intent, 'm2', '/a.zip', 1000)).toBeNull();
        expect(matchDownloadIntent(intent, 'm', '/b.zip', 1000)).toBeNull();
        expect(matchDownloadIntent(intent, 'm', '/a.zip', 1000 + DOWNLOAD_INTENT_TTL_MS + 1)).toBeNull();
        expect(matchDownloadIntent(null, 'm', '/a.zip', 1000)).toBeNull();
    });
    it('consuming an older intent leaves a newer push in place (newest wins)', () => {
        setDownloadIntent({ machineId: 'm', path: '/a.zip', auto: false }, 1);
        const first = peekDownloadIntent()!;
        setDownloadIntent({ machineId: 'm', path: '/b.zip', auto: false }, 2);
        consumeDownloadIntent(first);
        expect(peekDownloadIntent()?.path).toBe('/b.zip');
        consumeDownloadIntent(peekDownloadIntent()!);
        expect(peekDownloadIntent()).toBeNull();
    });
});
