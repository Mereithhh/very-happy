/**
 * Sentence-boundary truncation for TTS (pure, unit-tested).
 *
 * Server contract: POST /v1/voice/tts 400s on text > 2000 chars, so the cut
 * MUST happen client-side. Cutting mid-sentence sounds broken, so we prefer
 * the last sentence-ending punctuation within the budget, then the last
 * whitespace, then a hard cut.
 */

/** CJK + latin sentence enders; closing quotes/brackets may trail them. */
const SENTENCE_END = /[。！？!?；;.…\n]/;
const TRAILING_CLOSERS = new Set(['」', '』', '”', '’', '"', "'", ')', '）', ']', '】']);

export interface TruncateResult {
    text: string;
    truncated: boolean;
}

export function truncateAtSentenceBoundary(text: string, maxChars: number): TruncateResult {
    if (maxChars <= 0) return { text: '', truncated: text.length > 0 };
    if (text.length <= maxChars) return { text, truncated: false };

    const window = text.slice(0, maxChars);

    // last sentence end within budget
    let cut = -1;
    for (let i = window.length - 1; i >= 0; i--) {
        if (SENTENCE_END.test(window[i])) {
            cut = i;
            break;
        }
    }
    if (cut >= 0) {
        // include any closing quotes/brackets that directly follow the ender
        let end = cut + 1;
        while (end < window.length && TRAILING_CLOSERS.has(window[end])) end++;
        const candidate = window.slice(0, end).trimEnd();
        if (candidate.length > 0) return { text: candidate, truncated: true };
    }

    // no sentence boundary — fall back to the last whitespace
    const lastSpace = window.lastIndexOf(' ');
    if (lastSpace > 0) {
        return { text: window.slice(0, lastSpace).trimEnd(), truncated: true };
    }

    // hard cut (e.g. one giant CJK run with no punctuation)
    return { text: window, truncated: true };
}
