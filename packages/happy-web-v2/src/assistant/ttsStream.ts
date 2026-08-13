/**
 * ttsStream — streaming TTS over ElevenLabs' stream-input WebSocket (B-069).
 *
 * The browser connects DIRECTLY to ElevenLabs, authenticated by a single-use
 * token minted by our server (`single_use_token` query param — the API key
 * never ships to the client). A reply text is split into sentences (pure
 * splitter below), each sentence is sent as `{text, flush: true}`, and the
 * returned base64-mp3 chunks are re-assembled into ONE mp3 buffer PER
 * SENTENCE so the player can decode/play/caption sentence by sentence.
 *
 * Sentence↔chunk attribution: single-context stream-input has NO per-flush
 * completion signal (only one isFinal for the whole stream), so we count
 * `alignment.chars` per AudioOutput (requested via sync_alignment=true) and
 * complete a sentence when the cumulative count reaches its end. This is an
 * APPROXIMATION by design: a chunk may straddle a flush boundary, in which
 * case the straddled audio rides with the earlier sentence — playback order
 * and audio completeness are preserved, only the caption hand-off shifts by
 * one chunk. (The exact alternative — multi-stream-input with one context per
 * sentence and per-context finals — costs a 5-context concurrency budget and
 * a much bigger protocol surface for caption precision we don't need.)
 * Defensive fallback: if alignment is absent entirely, all chunks are
 * attributed on the final message (degrades to whole-reply latency, never
 * breaks, never double-plays).
 *
 * All protocol/assembly DECISIONS are pure and unit-tested; the socket is
 * injected (wsFactory) so the client state machine is testable without a
 * network.
 */

// ── sentence splitting (pure) ───────────────────────────────────────────────

/** CJK + latin sentence enders (same family as sentenceTruncate.ts). */
const SENTENCE_END = /[。！？!?；;…\n]/;
const TRAILING_CLOSERS = new Set(['」', '』', '”', '’', '"', "'", ')', '）', ']', '】']);

export interface SentenceSplitOptions {
    /** sentences shorter than this are merged with the following one */
    minChars?: number;
    /** hard split for punctuation-less runs */
    maxChars?: number;
}

export const SENTENCE_MIN_CHARS = 10;
export const SENTENCE_MAX_CHARS = 350;

/**
 * Split a reply into speakable sentence chunks. Rules:
 *  - cut after CJK/latin sentence enders (trailing closing quotes/brackets
 *    ride along with the sentence they close);
 *  - a latin '.' only ends a sentence when NOT followed by a digit/letter
 *    (so "3.14" and "v2.5" stay whole);
 *  - chunks shorter than minChars keep accumulating into the next cut
 *    (打招呼式短句不值得单独一个 WS 往返);
 *  - punctuation-less runs are hard-split at maxChars;
 *  - whitespace-only pieces are dropped.
 */
export function splitIntoSentences(text: string, opts: SentenceSplitOptions = {}): string[] {
    const minChars = opts.minChars ?? SENTENCE_MIN_CHARS;
    const maxChars = opts.maxChars ?? SENTENCE_MAX_CHARS;
    const out: string[] = [];
    let start = 0;
    let cursor = 0;

    const emit = (end: number, force: boolean) => {
        const piece = text.slice(start, end);
        if (piece.trim().length === 0) {
            // never emit whitespace-only; fold it into whatever follows
            if (force) start = end;
            return;
        }
        if (!force && piece.trim().length < minChars) return; // keep accumulating
        out.push(piece.trim());
        start = end;
    };

    while (cursor < text.length) {
        const ch = text[cursor];
        let isEnd = false;
        if (SENTENCE_END.test(ch)) {
            isEnd = true;
        } else if (ch === '.') {
            const next = text[cursor + 1];
            // ".5"/".b"/"3.14" style — not a sentence end
            isEnd = next === undefined || !/[\p{L}\p{N}]/u.test(next);
        }
        if (isEnd) {
            let end = cursor + 1;
            while (end < text.length && TRAILING_CLOSERS.has(text[end])) end++;
            emit(end, false);
            cursor = end;
            continue;
        }
        cursor++;
        if (cursor - start >= maxChars) emit(cursor, true);
    }
    emit(text.length, true);
    return out;
}

// ── chunk→sentence assembly (pure) ──────────────────────────────────────────

export interface TtsChunkEvent {
    /** decoded mp3 bytes of one AudioOutput message */
    audio: Uint8Array;
    /** alignment.chars.length of that message (0 when alignment missing) */
    alignedChars: number;
}

export interface AssemblerState {
    /** cumulative characters attributed so far */
    chars: number;
    /** chunks of the sentence currently being assembled */
    pending: Uint8Array[];
    /** index of the sentence currently being assembled */
    sentenceIndex: number;
}

export interface CompletedSentence {
    index: number;
    audio: Uint8Array;
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
    let total = 0;
    for (const p of parts) total += p.length;
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of parts) {
        out.set(p, off);
        off += p.length;
    }
    return out;
}

/**
 * Feed one audio chunk into the per-sentence assembler.
 * `sentenceCharEnds` = cumulative char count at the end of each SENT sentence
 * (i.e. lengths of the exact strings sent over the socket, running-summed).
 * Returns completed sentences (possibly several, if one chunk crossed
 * multiple short sentences) plus the next state. Pure.
 */
export function assemblerFeed(
    state: AssemblerState,
    sentenceCharEnds: number[],
    chunk: TtsChunkEvent,
): { state: AssemblerState; completed: CompletedSentence[] } {
    const pending = [...state.pending, chunk.audio];
    let chars = state.chars + chunk.alignedChars;
    let sentenceIndex = state.sentenceIndex;
    const completed: CompletedSentence[] = [];
    let bucket = pending;
    // a sentence is complete once the cumulative aligned chars reach its end
    while (sentenceIndex < sentenceCharEnds.length && chars >= sentenceCharEnds[sentenceIndex]) {
        completed.push({ index: sentenceIndex, audio: concatBytes(bucket) });
        bucket = [];
        sentenceIndex++;
    }
    return { state: { chars, pending: bucket, sentenceIndex }, completed };
}

/**
 * Stream ended (isFinal / clean close): whatever is still pending belongs to
 * the first incomplete sentence (alignment drift / missing alignment safety
 * net — audio must never be dropped). Pure.
 */
export function assemblerFinish(
    state: AssemblerState,
    sentenceCount: number,
): CompletedSentence[] {
    if (state.pending.length === 0 || state.sentenceIndex >= sentenceCount) return [];
    return [{ index: state.sentenceIndex, audio: concatBytes(state.pending) }];
}

export const assemblerInitial: AssemblerState = { chars: 0, pending: [], sentenceIndex: 0 };

// ── base64 helpers (pure-ish; atob is a global in browser + node ≥16) ───────

export function base64ToBytes(b64: string): Uint8Array {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

// ── WS client ────────────────────────────────────────────────────────────────

/** Structural WebSocket view — injectable for tests. */
export interface WsLike {
    send(data: string): void;
    close(): void;
    onopen: (() => void) | null;
    onmessage: ((ev: { data: unknown }) => void) | null;
    onerror: (() => void) | null;
    onclose: (() => void) | null;
}

export type WsFactory = (url: string) => WsLike;

export const TTS_STREAM_DEFAULT_MODEL_ID = 'eleven_flash_v2_5';
/** "Rachel" — mirrors the server-side default (ttsProxy.ts). */
export const TTS_STREAM_DEFAULT_VOICE_ID = '21m00Tcm4TlvDq8ikWAM';

export function buildTtsStreamUrl(opts: { voiceId: string; modelId: string; token: string }): string {
    const params = new URLSearchParams({
        model_id: opts.modelId,
        single_use_token: opts.token,
        // per-chunk alignment drives sentence attribution — ask explicitly
        // (docs are ambiguous on whether it comes back by default)
        sync_alignment: 'true',
        // keep the socket alive across slow sentence playback (max 180)
        inactivity_timeout: '60',
    });
    return `wss://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(opts.voiceId)}/stream-input?${params.toString()}`;
}

export type TtsStreamOutcome =
    /** every sentence delivered */
    | { kind: 'complete' }
    /** socket failed; sentences < failedAt already have audio */
    | { kind: 'failed'; failedAt: number }
    | { kind: 'aborted' };

export interface TtsStreamHandle {
    /** one promise per input sentence; resolves with its mp3 bytes, or null on failure/abort */
    sentenceAudio: Array<Promise<Uint8Array | null>>;
    /** overall outcome (resolves once, after all sentence promises settled) */
    outcome: Promise<TtsStreamOutcome>;
    abort(): void;
}

interface Deferred<T> {
    promise: Promise<T>;
    resolve: (v: T) => void;
}

function deferred<T>(): Deferred<T> {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => {
        resolve = r;
    });
    return { promise, resolve };
}

/**
 * Open a stream-input socket and synthesize `sentences` in order.
 * Protocol (per official docs):
 *  - init message: `{text: " ", ...}` (auth already in the URL token);
 *  - one `{text: "<sentence> ", flush: true}` per sentence (text must end
 *    with a space; flush forces generation at the sentence boundary);
 *  - `{text: ""}` closes the input side;
 *  - server replies `{audio: <base64>, alignment?}` chunks and a final
 *    `{isFinal: true}`.
 */
export function startTtsStream(opts: {
    token: string;
    sentences: string[];
    voiceId?: string;
    modelId?: string;
    wsFactory?: WsFactory;
}): TtsStreamHandle {
    const sentences = opts.sentences;
    const results = sentences.map(() => deferred<Uint8Array | null>());
    const outcome = deferred<TtsStreamOutcome>();
    const resolved = new Set<number>();
    let settled = false;
    let state = assemblerInitial;

    // exact strings sent over the wire (trailing space required by the API)
    const sentTexts = sentences.map((s) => `${s} `);
    const sentenceCharEnds: number[] = [];
    let running = 0;
    for (const s of sentTexts) {
        running += s.length;
        sentenceCharEnds.push(running);
    }

    const factory: WsFactory =
        opts.wsFactory ?? ((url) => new WebSocket(url) as unknown as WsLike);

    let ws: WsLike;
    try {
        ws = factory(
            buildTtsStreamUrl({
                voiceId: opts.voiceId || TTS_STREAM_DEFAULT_VOICE_ID,
                modelId: opts.modelId || TTS_STREAM_DEFAULT_MODEL_ID,
                token: opts.token,
            }),
        );
    } catch {
        for (const r of results) r.resolve(null);
        outcome.resolve({ kind: 'failed', failedAt: 0 });
        return { sentenceAudio: results.map((r) => r.promise), outcome: outcome.promise, abort: () => {} };
    }

    const deliver = (completed: CompletedSentence[]) => {
        for (const c of completed) {
            if (c.index < results.length && !resolved.has(c.index)) {
                resolved.add(c.index);
                results[c.index].resolve(c.audio);
            }
        }
    };

    const settle = (kind: TtsStreamOutcome, fill: Uint8Array | null) => {
        if (settled) return;
        settled = true;
        for (let i = 0; i < results.length; i++) {
            if (!resolved.has(i)) {
                resolved.add(i);
                results[i].resolve(fill);
            }
        }
        outcome.resolve(kind);
        try {
            ws.close();
        } catch {
            // already closed
        }
    };

    const finish = () => {
        // Server finished cleanly. Leftover chunks go to the first incomplete
        // sentence; any sentence still unresolved after that gets EMPTY audio
        // (not null): with alignment missing the whole reply's audio was
        // attributed to one sentence, and null would make the player believe
        // the stream failed and re-synthesize text it already played.
        deliver(assemblerFinish(state, sentences.length));
        state = { ...state, pending: [] };
        settle({ kind: 'complete' }, new Uint8Array(0));
    };

    ws.onopen = () => {
        if (settled) return;
        try {
            ws.send(JSON.stringify({ text: ' ' }));
            for (const text of sentTexts) {
                ws.send(JSON.stringify({ text, flush: true }));
            }
            ws.send(JSON.stringify({ text: '' }));
        } catch {
            settle({ kind: 'failed', failedAt: state.sentenceIndex }, null);
        }
    };

    ws.onmessage = (ev) => {
        if (settled || typeof ev.data !== 'string') return;
        let msg: {
            audio?: unknown;
            alignment?: { chars?: unknown } | null;
            normalizedAlignment?: { chars?: unknown } | null;
            isFinal?: unknown;
            is_final?: unknown;
        };
        try {
            msg = JSON.parse(ev.data);
        } catch {
            return;
        }
        // official schema says camelCase but page examples show snake_case —
        // accept both (docs inconsistency confirmed against the AsyncAPI spec)
        if (msg.isFinal === true || msg.is_final === true) {
            finish();
            return;
        }
        if (typeof msg.audio === 'string' && msg.audio.length > 0) {
            let audio: Uint8Array;
            try {
                audio = base64ToBytes(msg.audio);
            } catch {
                return;
            }
            // raw alignment matches our sent characters exactly; normalized
            // is a drifting approximation but still beats whole-reply latency
            const alignedChars = Array.isArray(msg.alignment?.chars)
                ? msg.alignment.chars.length
                : Array.isArray(msg.normalizedAlignment?.chars)
                    ? msg.normalizedAlignment.chars.length
                    : 0;
            const fed = assemblerFeed(state, sentenceCharEnds, { audio, alignedChars });
            state = fed.state;
            deliver(fed.completed);
        }
    };

    ws.onerror = () => {
        settle({ kind: 'failed', failedAt: state.sentenceIndex }, null);
    };

    ws.onclose = () => {
        // clean close without isFinal still flushes what we have
        if (!settled) finish();
    };

    return {
        sentenceAudio: results.map((r) => r.promise),
        outcome: outcome.promise,
        abort: () => settle({ kind: 'aborted' }, null),
    };
}
