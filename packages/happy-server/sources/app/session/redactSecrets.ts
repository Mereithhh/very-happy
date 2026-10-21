/**
 * B-701 best-effort secret masking for share-link transcripts (spec
 * specs/2026-10-session-sharing-tiers.md §2.5). A link viewer is anonymous,
 * so every string the server returns for a link passes through here. This is
 * a safety net, not a guarantee: the share panel says so.
 *
 * Patterns are deliberately concrete (known token shapes, PEM blocks, URL
 * credentials, `NAME=value` / `"name": "value"` assignments whose NAME says
 * it is a secret) so ordinary code and prose stay readable.
 *
 * ReDoS (security review): an anonymous viewer controls nothing here, but a
 * transcript can hold any text the agent saw. Every quantifier is bounded and
 * a single string is capped at MAX_REDACT_INPUT before any pattern runs, so
 * the cost per string is linear and small (perf test: 80 KB adversarial input
 * well under 50 ms).
 */
export const REDACTED = '[redacted]';
/** Longer strings are cut before masking; a share-link transcript does not need 100 KB tool dumps. */
export const MAX_REDACT_INPUT = 32 * 1024;
export const TRUNCATED_SUFFIX = '\n…[truncated]';

const SECRET_WORD = /SECRET|TOKEN|PASSWORD|PASSWD|PASSPHRASE|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|CREDENTIAL|COOKIE|DSN|DATABASE_URL/i;
const MAX_NAME = 64;
const MAX_VALUE = 512;

const PATTERNS: Array<[RegExp, string | ((...m: string[]) => string)]> = [
    // PEM private keys: header, body (base64 + RFC 1421 headers; never "--"), optional footer.
    // Greedy body + optional footer = no backtracking.
    [/-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----(?:[A-Za-z0-9+/=\s:,.]|-(?!-)){0,8192}(?:-----END [A-Z0-9 ]{0,40}PRIVATE KEY-----)?/g, REDACTED],
    // Credentials embedded in URLs: scheme://user:pass@host
    [/(?<![a-z0-9+.-])([a-z][a-z0-9+.-]{0,30}:\/\/)([^\s:@/]{1,128}):([^\s@/]{1,256})@/gi, (_m, scheme, user) => `${scheme}${user}:${REDACTED}@`],
    // Authorization headers / token words (case-insensitive: "bearer", "BEARER").
    [/\b(Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]{16,4096}/gi, (_m, kind) => `${kind} ${REDACTED}`],
    // Well-known token shapes.
    [/\bsk-ant-[A-Za-z0-9_-]{16,512}/g, REDACTED],
    [/\bsk-(?:proj-|live-|test-)?[A-Za-z0-9_-]{20,512}/g, REDACTED],
    [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,255}/g, REDACTED],
    [/\bgithub_pat_[A-Za-z0-9_]{20,255}/g, REDACTED],
    [/\bglpat-[A-Za-z0-9_-]{16,128}/g, REDACTED],
    [/\bxox[abposr]-[A-Za-z0-9-]{10,255}/g, REDACTED],
    [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, REDACTED],
    [/\bAIza[A-Za-z0-9_-]{35}\b/g, REDACTED],
    [/\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{16,255}/g, REDACTED],
    [/\bnpm_[A-Za-z0-9]{30,255}/g, REDACTED],
    // JWT: three base64url segments, header starts with eyJ.
    // The look-behind admits only token starts (not every "eyJ" inside a longer
    // base64url run), which keeps the per-start backtracking from going quadratic.
    [/(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,4096}\.[A-Za-z0-9_-]{8,8192}\.[A-Za-z0-9_-]{8,4096}/g, REDACTED],
];

const NAME_CHAR = new Uint8Array(128);
for (const c of 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_.-') NAME_CHAR[c.charCodeAt(0)] = 1;
const NOT_VALUE = new Uint8Array(128);
for (const c of ' \t\r\n\f\v"\';(),{}') NOT_VALUE[c.charCodeAt(0)] = 1;
const isNameChar = (code: number) => code < 128 && NAME_CHAR[code] === 1;
const isSpace = (code: number) => code === 32 || code === 9;
const isValueChar = (code: number) => !Number.isNaN(code) && (code >= 128 || NOT_VALUE[code] === 0);
const isWordOrParen = (code: number) => code === 40 || (code < 128 && NAME_CHAR[code] === 1 && code !== 46 && code !== 45);

/**
 * `NAME=value`, `NAME: value`, `"name": "value"` where NAME names a secret.
 * A hand-written scanner anchored on each `=` / `:` (look back ≤ 64 name
 * chars, forward ≤ 512 value chars) instead of a regex with a variable-length
 * prefix — the regex form is what backtracked catastrophically.
 */
export function maskSecretAssignments(text: string): string {
    let out = '';
    let copied = 0;
    const seps = /[=:]/g;
    let m: RegExpExecArray | null;
    while ((m = seps.exec(text)) !== null) {
        const sep = m.index;
        // ---- name, backwards
        let q = sep;
        let spaces = 0;
        while (q > copied && isSpace(text.charCodeAt(q - 1)) && spaces < 8) { q--; spaces++; }
        let nameQuote = 0;
        const before = text.charCodeAt(q - 1);
        if (before === 34 || before === 39) { nameQuote = before; q--; }
        let start = q;
        while (start > copied && isNameChar(text.charCodeAt(start - 1)) && q - start < MAX_NAME) start--;
        if (start === q || isNameChar(text.charCodeAt(start - 1))) continue;
        if (nameQuote && text.charCodeAt(start - 1) !== nameQuote) continue;
        if (!SECRET_WORD.test(text.slice(start, q))) continue;
        if (text.charCodeAt(sep) === 58 && text.charCodeAt(sep + 1) === 47) continue; // "://" is a URL, not an assignment
        // ---- value, forwards
        let v = sep + 1;
        spaces = 0;
        while (v < text.length && isSpace(text.charCodeAt(v)) && spaces < 8) { v++; spaces++; }
        const first = text.charCodeAt(v);
        const quote = first === 34 || first === 39 ? first : 0;
        const valueStart = quote ? v + 1 : v;
        let end = valueStart;
        if (quote) {
            while (end < text.length && text.charCodeAt(end) !== quote && text.charCodeAt(end) !== 10 && end - valueStart < MAX_VALUE) end++;
            if (text.charCodeAt(end) !== quote) continue;
        } else {
            while (end < text.length && isValueChar(text.charCodeAt(end)) && end - valueStart < MAX_VALUE) end++;
            // Ended naturally right before a word char or "(": a call / identifier — code, not a secret.
            if (end - valueStart < MAX_VALUE && end < text.length && isWordOrParen(text.charCodeAt(end))) continue;
        }
        if (end - valueStart < 4 || text.startsWith(REDACTED, valueStart)) continue;
        out += text.slice(copied, valueStart) + REDACTED;
        copied = end;
        seps.lastIndex = end;
    }
    return copied === 0 ? text : out + text.slice(copied);
}

/**
 * Extra text masked past a cut point, so a secret that STRADDLES the cut is
 * still matched whole before the cut is applied. Longer than any bounded
 * pattern (JWT ≤ ~16.4 KB, PEM ≤ 8 KB, assignments ≤ 576 chars).
 */
export const MASK_LOOKAHEAD = 20 * 1024;

/** Mask secrets in `text` as-is (no length cap — callers bound the input). */
export function maskSecrets(text: string): string {
    let out = text;
    for (const [pattern, replacement] of PATTERNS) {
        out = out.replace(pattern, replacement as any);
    }
    return maskSecretAssignments(out);
}

/**
 * Cut `masked` at `limit` without exposing the head of a secret: the input
 * was masked BEFORE cutting (window = limit + MASK_LOOKAHEAD), so everything
 * left of the cut is already masked; the last partial word is dropped too.
 */
export function cutMasked(masked: string, limit: number): string {
    if (masked.length <= limit) return masked;
    let cut = limit;
    const floor = Math.max(0, limit - 256);
    while (cut > floor && !/\s/.test(masked[cut - 1])) cut--;
    if (cut === floor) cut = limit; // one 256+ char word: keep the hard cut
    return masked.slice(0, cut) + TRUNCATED_SUFFIX;
}

/**
 * Mask `text` and return at most `limit` characters of it, without ever
 * exposing the front half of a secret that straddles the cut:
 *  1. take `limit + MASK_LOOKAHEAD` chars (bounded work),
 *  2. transform (`pre`, e.g. path scrub) and mask that window,
 *  3. cut. If the window itself clipped the input, a secret cut by the WINDOW
 *     end is unmasked — so the cut also stays ≥ MASK_LOOKAHEAD chars before
 *     the end of the masked window (replacements only shrink text, so the
 *     image of that partial token lies inside that tail).
 */
export function maskWithin(text: string, limit: number, pre?: (s: string) => string): string {
    const clipped = text.length > limit + MASK_LOOKAHEAD;
    const window = clipped ? text.slice(0, limit + MASK_LOOKAHEAD) : text;
    const masked = maskSecrets(pre ? pre(window) : window);
    const cut = clipped ? Math.min(limit, masked.length - MASK_LOOKAHEAD) : limit;
    if (cut <= 0) return TRUNCATED_SUFFIX.trim();
    return cutMasked(masked, cut);
}

/** Mask secrets inside one string, capped at MAX_REDACT_INPUT (mask first, then cut). */
export function redactSecrets(text: string): string {
    return maskWithin(text, MAX_REDACT_INPUT);
}

/** Deep copy of `value` with every string masked. */
export function redactSecretsDeep<T>(value: T): T {
    if (typeof value === 'string') return redactSecrets(value) as T;
    if (Array.isArray(value)) return value.map((item) => redactSecretsDeep(item)) as T;
    if (value && typeof value === 'object') {
        const out: Record<string, unknown> = {};
        for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
            out[key] = redactSecretsDeep(item);
        }
        return out as T;
    }
    return value;
}
