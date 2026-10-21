/**
 * B-701 best-effort secret masking for share-link transcripts (spec
 * specs/2026-10-session-sharing-tiers.md §2.5). A link viewer is anonymous,
 * so every string the server returns for a link passes through here. This is
 * a safety net, not a guarantee: the share panel says so.
 *
 * Patterns are deliberately concrete (known token shapes, PEM blocks, URL
 * credentials, `NAME=value` / `"name": "value"` assignments whose NAME says
 * it is a secret) so ordinary code and prose stay readable.
 */
export const REDACTED = '[redacted]';

const SECRET_NAME = String.raw`[A-Za-z0-9_.-]*(?:SECRET|TOKEN|PASSWORD|PASSWD|PASSPHRASE|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|CREDENTIALS?|COOKIE|DSN|DATABASE_URL)[A-Za-z0-9_.-]*`;

const PATTERNS: Array<[RegExp, string | ((...m: string[]) => string)]> = [
    // PEM private keys (whole block).
    [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, REDACTED],
    // Credentials embedded in URLs: scheme://user:pass@host
    [/\b([a-z][a-z0-9+.-]*:\/\/)([^\s:@/]+):([^\s@/]+)@/gi, (_m, scheme, user) => `${scheme}${user}:${REDACTED}@`],
    // Authorization headers.
    [/\b(Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]{16,}/g, (_m, kind) => `${kind} ${REDACTED}`],
    // Well-known token shapes.
    [/\bsk-ant-[A-Za-z0-9_-]{16,}/g, REDACTED],
    [/\bsk-(?:proj-|live-|test-)?[A-Za-z0-9_-]{20,}/g, REDACTED],
    [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, REDACTED],
    [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, REDACTED],
    [/\bglpat-[A-Za-z0-9_-]{16,}/g, REDACTED],
    [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, REDACTED],
    [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, REDACTED],
    [/\bAIza[A-Za-z0-9_-]{35}\b/g, REDACTED],
    [/\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g, REDACTED],
    [/\bnpm_[A-Za-z0-9]{30,}/g, REDACTED],
    // JWT: three base64url segments, header starts with eyJ.
    [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, REDACTED],
    // "secretName": "value"  /  'secretName': 'value'
    [new RegExp(String.raw`(["'])(${SECRET_NAME})\1(\s*:\s*)(["'])([^"'\n]{4,})\4`, 'gi'), (_m, q, name, sep, q2) => `${q}${name}${q}${sep}${q2}${REDACTED}${q2}`],
    // NAME=value  /  NAME: value  (env files, shell exports, YAML)
    [new RegExp(String.raw`\b(${SECRET_NAME})(\s*[=:]\s*)(?!${escape(REDACTED)})(["']?)([^\s"'\n;(),{}]{4,})\3(?![\w(])`, 'gi'), (_m, name, sep, q) => `${name}${sep}${q}${REDACTED}${q}`],
];

function escape(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Mask secrets inside one string. */
export function redactSecrets(text: string): string {
    let out = text;
    for (const [pattern, replacement] of PATTERNS) {
        out = out.replace(pattern, replacement as any);
    }
    return out;
}

/** Deep copy of `value` with every string (and object key's value) masked. */
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
