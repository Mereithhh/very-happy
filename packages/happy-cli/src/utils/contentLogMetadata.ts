/**
 * Build content-free metadata for diagnostic logging.
 *
 * User prompts, model responses, tool payloads, hook bodies, and notification
 * copy may all contain source code or secrets. Callers should log only these
 * bounded structural facts and keep the original value on the data path.
 */

function serializedByteLength(value: unknown): number | undefined {
    try {
        const serialized = JSON.stringify(value);
        return serialized === undefined ? undefined : Buffer.byteLength(serialized, 'utf8');
    } catch {
        return undefined;
    }
}

export function contentLogMetadata(value: unknown): Record<string, unknown> {
    if (typeof value === 'string') {
        return {
            valueType: 'string',
            valueBytes: Buffer.byteLength(value, 'utf8'),
        };
    }

    if (Array.isArray(value)) {
        return {
            valueType: 'array',
            itemCount: value.length,
            payloadBytes: serializedByteLength(value),
        };
    }

    if (value && typeof value === 'object') {
        return {
            valueType: 'object',
            keyCount: Object.keys(value as Record<string, unknown>).length,
            payloadBytes: serializedByteLength(value),
        };
    }

    return { valueType: value === null ? 'null' : typeof value };
}

export function errorLogMetadata(error: unknown): Record<string, unknown> {
    if (error instanceof Error) {
        const code = (error as NodeJS.ErrnoException).code;
        return {
            errorType: error.name || 'Error',
            ...(typeof code === 'string' ? { errorCode: code } : {}),
        };
    }

    if (error && typeof error === 'object') {
        const record = error as Record<string, unknown>;
        const code = record.code;
        return {
            errorType: 'object',
            ...(typeof code === 'string' || typeof code === 'number' ? { errorCode: code } : {}),
        };
    }

    return { errorType: error === null ? 'null' : typeof error };
}
