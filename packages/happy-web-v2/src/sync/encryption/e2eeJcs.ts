/** RFC 8785 JSON Canonicalization Scheme for the JSON subset used by E2EE. */

function assertUnicodeScalarString(value: string): void {
    for (let i = 0; i < value.length; i++) {
        const code = value.charCodeAt(i);
        if (code >= 0xd800 && code <= 0xdbff) {
            const next = value.charCodeAt(i + 1);
            if (!(next >= 0xdc00 && next <= 0xdfff)) {
                throw new Error('JCS strings cannot contain lone surrogates');
            }
            i++;
        } else if (code >= 0xdc00 && code <= 0xdfff) {
            throw new Error('JCS strings cannot contain lone surrogates');
        }
    }
}

function serialize(value: unknown, seen: Set<object>): string {
    if (value === null) return 'null';
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    if (typeof value === 'string') {
        assertUnicodeScalarString(value);
        return JSON.stringify(value);
    }
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) throw new Error('JCS numbers must be finite');
        return JSON.stringify(value);
    }
    if (typeof value !== 'object') throw new Error('Unsupported JCS value');
    if (seen.has(value)) throw new Error('JCS values cannot be cyclic');
    seen.add(value);
    try {
        if (Array.isArray(value)) {
            return `[${value.map((item) => serialize(item, seen)).join(',')}]`;
        }
        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null) {
            throw new Error('JCS objects must be plain objects');
        }
        const record = value as Record<string, unknown>;
        const keys = Object.keys(record).sort(); // RFC 8785: UTF-16 code-unit order.
        return `{${keys.map((key) => {
            assertUnicodeScalarString(key);
            if (record[key] === undefined) throw new Error('JCS cannot encode undefined');
            return `${JSON.stringify(key)}:${serialize(record[key], seen)}`;
        }).join(',')}}`;
    } finally {
        seen.delete(value);
    }
}

export function jcsCanonicalize(value: unknown): string {
    return serialize(value, new Set());
}

export function parseCanonicalJcs(value: string, maxUtf8Bytes = 64 * 1024): unknown {
    if (new TextEncoder().encode(value).length > maxUtf8Bytes) {
        throw new Error('JCS payload is too large');
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(value);
    } catch {
        throw new Error('Invalid JSON');
    }
    // This also rejects whitespace, unknown duplicate-key spellings, alternate
    // number forms, and non-canonical property order.
    if (jcsCanonicalize(parsed) !== value) throw new Error('Non-canonical JCS');
    return parsed;
}

