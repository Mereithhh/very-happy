/**
 * B-688 secret handling for harness model configs (spec specs/2026-10-custom-models.md §安全).
 *
 * Every value that leaves the daemon (read views, diff previews, audit lines,
 * errors) goes through here. The rule is structural, not per-field: any value
 * stored under a key that LOOKS like a credential is masked, wherever it sits
 * in the file — so a user's own `OPENAI_API_KEY` in Claude's `env` block, or a
 * `http_headers.Authorization` in a Codex provider table, is masked too.
 */

/** Keys whose values are treated as secrets (case-insensitive, matched on the leaf key). */
const SECRET_KEY_PATTERN = /(api[_-]?key|apikey|token|secret|password|passwd|authorization|bearer|credential|cookie|private[_-]?key)/i;

/** Env-var names Claude Code reads a credential from even though they don't match the pattern. */
const EXTRA_SECRET_KEYS = new Set(['ANTHROPIC_CUSTOM_HEADERS']);

export function isSecretKey(key: string): boolean {
    return SECRET_KEY_PATTERN.test(key) || EXTRA_SECRET_KEYS.has(key);
}

/**
 * `sk-a…9f3c` for long values, `••••` for short ones. Never more than 4+4
 * characters of the original, and only when the value is long enough (≥ 16)
 * that 8 characters are a small fraction of it.
 */
export function maskSecret(value: string): string {
    const v = value.trim();
    if (!v) return '';
    if (v.length < 16) return '••••';
    return `${v.slice(0, 4)}…${v.slice(-4)}`;
}

/** Collect every string stored under a secret-looking key, at any depth. */
export function collectSecretValues(value: unknown, out: Set<string> = new Set(), parentKey = ''): Set<string> {
    if (typeof value === 'string') {
        if (parentKey && isSecretKey(parentKey) && value.length >= 4) out.add(value);
        return out;
    }
    if (Array.isArray(value)) {
        for (const item of value) collectSecretValues(item, out, parentKey);
        return out;
    }
    if (value && typeof value === 'object') {
        for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
            collectSecretValues(child, out, key);
        }
    }
    return out;
}

/** Replace every occurrence of every secret in `text` with its mask (longest first). */
export function redactText(text: string, secrets: Iterable<string>): string {
    const list = [...new Set(secrets)].filter(s => s.length >= 4).sort((a, b) => b.length - a.length);
    let out = text;
    for (const secret of list) {
        out = out.split(secret).join(maskSecret(secret));
    }
    return out;
}

/** Env-var name accepted for "reference an environment variable instead of a literal key". */
export const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

export function isValidEnvName(name: unknown): name is string {
    return typeof name === 'string' && ENV_NAME_PATTERN.test(name);
}
