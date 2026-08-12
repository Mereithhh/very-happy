import { describe, expect, it } from 'vitest';
import {
    TTS_DEFAULT_MODEL_ID,
    TTS_DEFAULT_VOICE_ID,
    TTS_MAX_TEXT_CHARS,
    buildTtsRequest,
    createTimedCache,
    fetchSlimVoices,
    proxyTts,
    slimVoices,
    validateTtsText,
    type FetchLike,
    type FetchLikeResponse,
} from './ttsProxy';

function fakeResponse(partial: Partial<FetchLikeResponse>): FetchLikeResponse {
    return {
        ok: true,
        status: 200,
        body: null,
        text: async () => '',
        json: async () => ({}),
        ...partial,
    };
}

describe('validateTtsText', () => {
    it('rejects empty and whitespace-only text', () => {
        expect(validateTtsText('')).toEqual({ ok: false, error: 'Text is empty' });
        expect(validateTtsText('   \n\t ')).toMatchObject({ ok: false });
    });

    it('accepts text up to the cap', () => {
        expect(validateTtsText('hello')).toEqual({ ok: true });
        expect(validateTtsText('a'.repeat(TTS_MAX_TEXT_CHARS))).toEqual({ ok: true });
    });

    it('rejects over-length text instead of truncating', () => {
        const result = validateTtsText('a'.repeat(TTS_MAX_TEXT_CHARS + 1));
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.error).toContain(String(TTS_MAX_TEXT_CHARS));
        }
    });
});

describe('buildTtsRequest', () => {
    it('applies default voice and model', () => {
        const { url, body } = buildTtsRequest({ text: 'hi' });
        expect(url).toBe(`https://api.elevenlabs.io/v1/text-to-speech/${TTS_DEFAULT_VOICE_ID}/stream`);
        expect(body).toEqual({ text: 'hi', model_id: TTS_DEFAULT_MODEL_ID });
    });

    it('uses the flash model as the default (turbo family is deprecated)', () => {
        expect(TTS_DEFAULT_MODEL_ID).toBe('eleven_flash_v2_5');
    });

    it('honors explicit voice and model, url-encoding the voice id', () => {
        const { url, body } = buildTtsRequest({ text: 'hi', voiceId: 'abc/../x', modelId: 'eleven_multilingual_v2' });
        expect(url).toBe('https://api.elevenlabs.io/v1/text-to-speech/abc%2F..%2Fx/stream');
        expect(body.model_id).toBe('eleven_multilingual_v2');
    });

    it('treats empty-string overrides as unset', () => {
        const { url, body } = buildTtsRequest({ text: 'hi', voiceId: '', modelId: '' });
        expect(url).toContain(TTS_DEFAULT_VOICE_ID);
        expect(body.model_id).toBe(TTS_DEFAULT_MODEL_ID);
    });
});

describe('proxyTts', () => {
    it('POSTs to the stream endpoint with the api key and returns the body on 2xx', async () => {
        const calls: Array<{ url: string; init: any }> = [];
        const stream = { fake: 'stream' };
        const fetchImpl: FetchLike = async (url, init) => {
            calls.push({ url, init });
            return fakeResponse({ body: stream });
        };

        const result = await proxyTts({
            apiKey: 'k-123',
            text: 'hello world',
            fetchImpl,
        });

        expect(result).toEqual({ kind: 'stream', body: stream });
        expect(calls).toHaveLength(1);
        expect(calls[0].url).toContain('/text-to-speech/');
        expect(calls[0].url.endsWith('/stream')).toBe(true);
        expect(calls[0].init.method).toBe('POST');
        expect(calls[0].init.headers['xi-api-key']).toBe('k-123');
        expect(JSON.parse(calls[0].init.body)).toEqual({ text: 'hello world', model_id: TTS_DEFAULT_MODEL_ID });
    });

    it('passes the abort signal through to fetch', async () => {
        const controller = new AbortController();
        let seenSignal: unknown = null;
        const fetchImpl: FetchLike = async (_url, init) => {
            seenSignal = init?.signal;
            return fakeResponse({ body: {} });
        };
        await proxyTts({ apiKey: 'k', text: 'x', signal: controller.signal, fetchImpl });
        expect(seenSignal).toBe(controller.signal);
    });

    it('returns upstream_error with status and detail on non-2xx', async () => {
        const fetchImpl: FetchLike = async () =>
            fakeResponse({ ok: false, status: 422, text: async () => 'bad voice' });
        const result = await proxyTts({ apiKey: 'k', text: 'x', fetchImpl });
        expect(result).toEqual({ kind: 'upstream_error', status: 422, detail: 'bad voice' });
    });

    it('tolerates an unreadable error body', async () => {
        const fetchImpl: FetchLike = async () =>
            fakeResponse({ ok: false, status: 500, text: async () => { throw new Error('boom'); } });
        const result = await proxyTts({ apiKey: 'k', text: 'x', fetchImpl });
        expect(result).toEqual({ kind: 'upstream_error', status: 500, detail: '' });
    });
});

describe('slimVoices', () => {
    it('maps ElevenLabs voices to the slim shape', () => {
        const raw = {
            voices: [
                {
                    voice_id: 'v1',
                    name: 'Rachel',
                    preview_url: 'https://x/preview.mp3',
                    labels: { accent: 'american', age: 'young' },
                    settings: { stability: 0.5 },
                    high_quality_base_model_ids: ['a'],
                },
            ],
        };
        expect(slimVoices(raw)).toEqual([
            {
                voiceId: 'v1',
                name: 'Rachel',
                previewUrl: 'https://x/preview.mp3',
                labels: { accent: 'american', age: 'young' },
            },
        ]);
    });

    it('omits labels when absent or empty, defaults missing preview/name', () => {
        const raw = {
            voices: [
                { voice_id: 'v1', labels: {} },
                { voice_id: 'v2', name: 'B', preview_url: null },
            ],
        };
        expect(slimVoices(raw)).toEqual([
            { voiceId: 'v1', name: 'v1', previewUrl: '' },
            { voiceId: 'v2', name: 'B', previewUrl: '' },
        ]);
    });

    it('drops non-string label values and entries without a voice_id', () => {
        const raw = {
            voices: [
                { voice_id: 'v1', name: 'A', labels: { accent: 'us', verified: true } },
                { name: 'no-id' },
                null,
                'garbage',
            ],
        };
        expect(slimVoices(raw)).toEqual([
            { voiceId: 'v1', name: 'A', previewUrl: '', labels: { accent: 'us' } },
        ]);
    });

    it('returns [] for malformed payloads', () => {
        expect(slimVoices(null)).toEqual([]);
        expect(slimVoices('x')).toEqual([]);
        expect(slimVoices({})).toEqual([]);
        expect(slimVoices({ voices: 'nope' })).toEqual([]);
    });
});

describe('fetchSlimVoices', () => {
    it('GETs /v1/voices with the api key and slims the result', async () => {
        const calls: Array<{ url: string; init: any }> = [];
        const fetchImpl: FetchLike = async (url, init) => {
            calls.push({ url, init });
            return fakeResponse({
                json: async () => ({ voices: [{ voice_id: 'v1', name: 'A', preview_url: 'p' }] }),
            });
        };

        const result = await fetchSlimVoices({ apiKey: 'k-9', fetchImpl });
        expect(result).toEqual({ ok: true, voices: [{ voiceId: 'v1', name: 'A', previewUrl: 'p' }] });
        expect(calls[0].url).toBe('https://api.elevenlabs.io/v1/voices');
        expect(calls[0].init.headers['xi-api-key']).toBe('k-9');
    });

    it('surfaces the upstream status on non-2xx', async () => {
        const fetchImpl: FetchLike = async () => fakeResponse({ ok: false, status: 503 });
        expect(await fetchSlimVoices({ apiKey: 'k', fetchImpl })).toEqual({ ok: false, status: 503 });
    });

    it('treats an unparsable 2xx body as an empty list', async () => {
        const fetchImpl: FetchLike = async () =>
            fakeResponse({ json: async () => { throw new Error('not json'); } });
        expect(await fetchSlimVoices({ apiKey: 'k', fetchImpl })).toEqual({ ok: true, voices: [] });
    });
});

describe('createTimedCache', () => {
    it('returns the value within the TTL and null after it expires', () => {
        const cache = createTimedCache<string>(60_000);
        expect(cache.get(0)).toBeNull();
        cache.set('hello', 1_000);
        expect(cache.get(1_000)).toBe('hello');
        expect(cache.get(60_999)).toBe('hello');
        expect(cache.get(61_000)).toBeNull();
        // Expired entries stay gone even if the clock rolls back.
        expect(cache.get(1_000)).toBeNull();
    });

    it('set replaces the previous value and resets the clock', () => {
        const cache = createTimedCache<number>(100);
        cache.set(1, 0);
        cache.set(2, 90);
        expect(cache.get(150)).toBe(2);
        expect(cache.get(190)).toBeNull();
    });
});
