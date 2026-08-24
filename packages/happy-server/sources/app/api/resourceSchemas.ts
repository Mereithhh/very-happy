import { decodePrismaBytes } from '@/storage/prismaBytes';
import { z } from 'zod';

export function utf8StringSchema(options: { minBytes?: number; maxBytes: number }) {
    return z.string().superRefine((value, ctx) => {
        const bytes = Buffer.byteLength(value, 'utf8');
        if (options.minBytes !== undefined && bytes < options.minBytes) {
            ctx.addIssue({ code: 'custom', message: `Must contain at least ${options.minBytes} UTF-8 byte(s)` });
        }
        if (bytes > options.maxBytes) {
            ctx.addIssue({ code: 'custom', message: `Must contain at most ${options.maxBytes} UTF-8 bytes` });
        }
    });
}

/** Canonical standard-base64 input with a decoded byte bound. */
export function base64BytesSchema(maxBytes: number) {
    const maxEncodedChars = Math.ceil(maxBytes / 3) * 4;
    return z.string().max(maxEncodedChars).superRefine((value, ctx) => {
        try {
            const decoded = decodePrismaBytes(value);
            if (decoded.byteLength > maxBytes) {
                ctx.addIssue({ code: 'custom', message: `Decoded value must contain at most ${maxBytes} bytes` });
            }
        } catch {
            ctx.addIssue({ code: 'custom', message: 'Must be canonical base64' });
        }
    });
}
