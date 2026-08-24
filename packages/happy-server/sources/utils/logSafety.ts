import { createHash } from 'node:crypto';

const MAX_LOG_TEXT_BYTES = 2_048;
const MAX_LOG_DEPTH = 5;

const SECRET_KEY = /(?:authorization|cookie|credential|password|private.?key|secret|token)$/i;
const CONTENT_KEY = /(?:body|content|detail|endpoint|err|error|message|payload|path|prompt|reason|response|stack|text|url)$/i;
const IDENTIFIER_KEY = /^(?:accountId|conversationId|deviceId|githubUserId|machineId|roomId|sessionId|socketId|tag|userId|voiceId)$/i;
const SAFE_STRING_KEY = /^(?:client|clientType|code|connectionType|event|event_type|kind|lang|language|level|method|mode|module|operation|platform|provider|resource|role|source|status|type)$/i;

function byteLength(value: string): number {
    return Buffer.byteLength(value, 'utf8');
}

function boundedCategory(value: unknown, fallback: string): string {
    if (typeof value !== 'string') return fallback;
    return /^[A-Za-z][A-Za-z0-9._:-]{0,63}$/.test(value) ? value : fallback;
}

/**
 * Stable, non-reversible correlation label for operational logs. This is
 * deliberately unkeyed: self-hosters need no extra master secret, while raw
 * structured account/session/machine identifier fields stay out of the sink.
 */
export function stableLogRef(kind: string, value: unknown): string {
    const safeKind = boundedCategory(kind, 'ref').toLowerCase();
    if (value === undefined || value === null || value === '') return `${safeKind}:none`;
    try {
        const digest = createHash('sha256')
            .update(`${safeKind}\0${String(value)}`)
            .digest('hex')
            .slice(0, 16);
        return `${safeKind}:${digest}`;
    } catch {
        return `${safeKind}:invalid`;
    }
}

export type SafeErrorMetadata = {
    errorType: string;
    code?: string;
    status?: number;
};

/** Preserve actionable categories without persisting provider/DB error text. */
export function safeErrorMetadata(error: unknown): SafeErrorMetadata {
    if (!(error instanceof Error) && (!error || typeof error !== 'object')) {
        return { errorType: `non-error-${typeof error}` };
    }

    try {
        const candidate = error as { name?: unknown; code?: unknown; status?: unknown; statusCode?: unknown };
        const metadata: SafeErrorMetadata = {
            errorType: boundedCategory(candidate.name, error instanceof Error ? 'Error' : 'object'),
        };
        if (candidate.code !== undefined) metadata.code = boundedCategory(candidate.code, 'unknown');
        const status = candidate.statusCode ?? candidate.status;
        if (typeof status === 'number' && Number.isSafeInteger(status) && status >= 100 && status <= 599) {
            metadata.status = status;
        }
        return metadata;
    } catch {
        return { errorType: 'uninspectable-error' };
    }
}

/**
 * Last-resort protection for plain log messages. Call sites must still avoid
 * interpolating user/provider content; this removes common credential and PII
 * shapes and caps accidental amplification.
 */
export function sanitizeLogText(value: string): string {
    const preTruncated = value.length > MAX_LOG_TEXT_BYTES * 4;
    let safe = (preTruncated ? value.slice(0, MAX_LOG_TEXT_BYTES * 4) : value)
        .replace(/[\r\n\t]+/g, ' ')
        .replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
        .replace(/\b[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g, '[jwt-redacted]')
        .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email-redacted]')
        .replace(/\b(?:https?|wss?):\/\/[^\s]+/gi, '[url-redacted]');

    if (!preTruncated && byteLength(safe) <= MAX_LOG_TEXT_BYTES) return safe;
    const suffix = '[truncated]';
    const encoded = Buffer.from(safe, 'utf8');
    const contentBudget = MAX_LOG_TEXT_BYTES - byteLength(suffix);
    const bounded = encoded.subarray(0, contentBudget).toString('utf8').replace(/\uFFFD$/u, '');
    return `${bounded}${suffix}`;
}

function contentSummary(value: unknown): string {
    if (typeof value === 'string') return `[content:${byteLength(value)}B]`;
    if (Buffer.isBuffer(value)) return `[content:${value.byteLength}B]`;
    if (value instanceof Uint8Array) return `[content:${value.byteLength}B]`;
    if (value === null) return '[content:null]';
    if (value === undefined) return '[content:undefined]';
    if (Array.isArray(value)) return `[content:array:${value.length}]`;
    return `[content:${typeof value}]`;
}

/** Sanitize structured arguments before they reach either console or file. */
export function sanitizeLogValue(value: unknown, key?: string, seen = new WeakSet<object>(), depth = 0): unknown {
    if (key && SECRET_KEY.test(key)) return '[redacted]';
    if (key && IDENTIFIER_KEY.test(key)) return stableLogRef(key, value);
    if (key && CONTENT_KEY.test(key)) {
        if (/^(?:error|err)$/i.test(key)) return safeErrorMetadata(value);
        return contentSummary(value);
    }

    if (value instanceof Error) return safeErrorMetadata(value);
    if (typeof value === 'string') {
        if (!key || SAFE_STRING_KEY.test(key)) return sanitizeLogText(value);
        return contentSummary(value);
    }
    if (value === null || value === undefined || typeof value === 'number' || typeof value === 'boolean') return value;
    if (typeof value === 'bigint') return value.toString();
    if (typeof value !== 'object') return `[${typeof value}]`;
    if (Buffer.isBuffer(value)) return `[buffer:${value.byteLength}B]`;
    if (value instanceof Uint8Array) return `[bytes:${value.byteLength}B]`;
    if (depth >= MAX_LOG_DEPTH) return '[max-depth]';
    if (seen.has(value)) return '[circular]';
    seen.add(value);

    if (Array.isArray(value)) {
        return value.slice(0, 32).map((item) => sanitizeLogValue(item, key ?? 'item', seen, depth + 1));
    }

    const output: Record<string, unknown> = {};
    try {
        for (const [entryKey, entryValue] of Object.entries(value)) {
            output[entryKey] = sanitizeLogValue(entryValue, entryKey, seen, depth + 1);
        }
    } catch {
        return '[uninspectable-object]';
    }
    return output;
}
