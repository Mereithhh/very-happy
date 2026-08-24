function byteLength(value: string): number {
    return Buffer.byteLength(value, 'utf8');
}

function safeTypeToken(value: unknown): string {
    if (typeof value !== 'string') return typeof value;
    return /^[a-z][a-z0-9_.-]{0,63}$/i.test(value) ? value : 'unknown';
}

export function logValueMetadata(value: unknown): { valueType: string; valueBytes?: number } {
    return typeof value === 'string'
        ? { valueType: 'string', valueBytes: byteLength(value) }
        : { valueType: value === null ? 'null' : typeof value };
}

/** Allowlisted diagnostics for provider events; never returns event fields. */
export function codexEventLogMetadata(value: unknown): {
    eventType: string;
    payloadBytes?: number;
    hasId: boolean;
} {
    const event = value && typeof value === 'object' ? value as Record<string, unknown> : {};
    let payloadBytes: number | undefined;
    try {
        const encoded = JSON.stringify(value);
        if (encoded !== undefined) payloadBytes = byteLength(encoded);
    } catch {
        // A circular provider payload is still loggable by type, without data.
    }
    return {
        eventType: safeTypeToken(event.type),
        ...(payloadBytes === undefined ? {} : { payloadBytes }),
        hasId: typeof event.id === 'string' || typeof event.turn_id === 'string' || typeof event.callId === 'string',
    };
}

/** Errors may echo prompts/request bodies, so retain only machine-readable shape. */
export function safeCodexErrorMetadata(value: unknown): {
    errorType: string;
    code?: string | number;
    codeBytes?: number;
    status?: number;
} {
    if (!value || typeof value !== 'object') return { errorType: typeof value };
    const error = value as {
        name?: unknown;
        code?: unknown;
        status?: unknown;
        response?: { status?: unknown };
    };
    const status = error.status ?? error.response?.status;
    const safeCode = typeof error.code === 'string' && /^[a-z0-9_.-]{1,64}$/i.test(error.code)
        ? { code: error.code }
        : typeof error.code === 'number'
            ? { code: error.code }
            : typeof error.code === 'string'
                ? { codeBytes: byteLength(error.code) }
                : {};
    return {
        errorType: safeTypeToken(error.name ?? value.constructor?.name),
        ...safeCode,
        ...(typeof status === 'number' ? { status } : {}),
    };
}
