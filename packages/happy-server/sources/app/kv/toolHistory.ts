import { randomUUID } from 'node:crypto';
import * as privacyKit from 'privacy-kit';
import { z } from 'zod';
import { kvGet } from '@/app/kv/kvGet';
import { kvMutate } from '@/app/kv/kvMutate';
import { warn } from '@/utils/log';

export const TOOL_HISTORY_PAYLOAD_MAX_BYTES = 48 * 1024;
const TOOL_HISTORY_MAX_ENTRIES = 50;
const TOOL_HISTORY_MAX_BYTES = 240 * 1024;
const TOOL_HISTORY_CAS_ATTEMPTS = 8;
const TOOL_HISTORY_MAX_PENDING_PER_SCOPE = 50;
const TOOL_HISTORY_MAX_PENDING = 200;

export type ToolHistorySource =
    | { sourceType: 'session'; sessionId: string }
    | { sourceType: 'machine'; machineId: string; terminalId?: string };

const entrySchema = z.object({
    id: z.string(),
    kind: z.enum(['clipboard', 'preview']),
    createdAt: z.number().nonnegative().finite(),
    payload: z.string().refine(value => Buffer.byteLength(value, 'utf8') <= TOOL_HISTORY_PAYLOAD_MAX_BYTES),
    enc: z.boolean(),
    truncated: z.boolean().optional(),
    totalBytes: z.number().int().nonnegative().safe().optional(),
    mode: z.enum(['file', 'diff']).optional(),
});
const historySchema = z.object({ version: z.literal(1), entries: z.array(entrySchema) });

export type ToolHistoryEntry = z.infer<typeof entrySchema>;
export type ToolHistoryInput = Omit<ToolHistoryEntry, 'id' | 'createdAt'>;

export function validTerminalId(value: unknown): value is string | undefined {
    return value === undefined || (typeof value === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(value));
}

export function toolHistoryKey(source: ToolHistorySource): string | null {
    if (source.sourceType === 'session') {
        return `tool-history.v1/session/${encodeURIComponent(source.sessionId)}`;
    }
    return source.terminalId
        ? `tool-history.v1/terminal/${encodeURIComponent(source.machineId)}/${encodeURIComponent(source.terminalId)}`
        : null;
}

function decodeHistory(value: string | null): ToolHistoryEntry[] {
    if (!value) return [];
    try {
        const bytes = privacyKit.decodeBase64(value);
        if (bytes.byteLength > TOOL_HISTORY_MAX_BYTES) return [];
        const parsed = historySchema.safeParse(JSON.parse(new TextDecoder().decode(bytes)));
        return parsed.success ? parsed.data.entries : [];
    } catch {
        return [];
    }
}

function appendHistory(value: string | null, entry: ToolHistoryEntry): string {
    const entries = [entry, ...decodeHistory(value)]
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, TOOL_HISTORY_MAX_ENTRIES);
    let json = JSON.stringify({ version: 1, entries });
    while (Buffer.byteLength(json, 'utf8') > TOOL_HISTORY_MAX_BYTES && entries.length > 0) {
        entries.pop();
        json = JSON.stringify({ version: 1, entries });
    }
    return privacyKit.encodeBase64(new TextEncoder().encode(json));
}

// Serialize local calls per account/scope so a burst does not exhaust CAS
// retries by racing itself. CAS still protects against another server process
// or a client mutating the same account KV key.
const pendingScopes = new Map<string, Promise<void>>();
const pendingScopeCounts = new Map<string, number>();
let pendingCount = 0;

/** Records receipt of a valid tool push, independently of the live relay.
 * It does not assert that a Web client viewed it or copied to its clipboard.
 * kvMutate retains the existing quotas, account lock, transaction retry and
 * kv-batch-update notification. Failures must not disrupt live delivery. */
export async function recordToolHistory(
    userId: string,
    source: ToolHistorySource,
    input: ToolHistoryInput,
): Promise<void> {
    const key = toolHistoryKey(source);
    if (!key) return;
    const kind = input.kind;
    const scope = JSON.stringify([userId, key]);
    const scopeCount = pendingScopeCounts.get(scope) ?? 0;
    if (scopeCount >= TOOL_HISTORY_MAX_PENDING_PER_SCOPE || pendingCount >= TOOL_HISTORY_MAX_PENDING) {
        warn({ module: 'tool-history', kind, reason: 'queue-full' }, 'Tool history was not saved');
        return;
    }
    const entry: ToolHistoryEntry = {
        ...input,
        // Ciphertext is opaque: omit an oversized body, never slice it.
        ...(Buffer.byteLength(input.payload, 'utf8') > TOOL_HISTORY_PAYLOAD_MAX_BYTES
            ? { payload: '', truncated: true }
            : {}),
        id: randomUUID(),
        createdAt: Date.now(),
    };
    // Legacy unencrypted strings may expand sixfold when JSON escapes control
    // characters. Preserve the call marker if its body alone exceeds the log.
    if (Buffer.byteLength(JSON.stringify({ version: 1, entries: [entry] }), 'utf8') > TOOL_HISTORY_MAX_BYTES) {
        entry.payload = '';
        entry.truncated = true;
    }
    pendingScopeCounts.set(scope, scopeCount + 1);
    pendingCount += 1;
    const previous = pendingScopes.get(scope) ?? Promise.resolve();
    const pending = previous.then(async () => {
        try {
            const existing = await kvGet({ uid: userId }, key);
            let version = existing?.version ?? -1;
            let value = existing?.value ?? null;
            for (let attempt = 0; attempt < TOOL_HISTORY_CAS_ATTEMPTS; attempt += 1) {
                const result = await kvMutate({ uid: userId }, [{ key, value: appendHistory(value, entry), version }]);
                if (result.success) return;
                const conflict = result.errors?.find(error => error.key === key && error.error === 'version-mismatch');
                if (!conflict) break;
                // kvGet hides tombstones, while CAS supplies their actual
                // version; retry against it rather than trying version -1.
                version = conflict.version;
                value = conflict.value;
            }
            warn({ module: 'tool-history', kind, reason: 'version-conflict' }, 'Tool history was not saved');
        } catch {
            // Error messages can contain SQL/data. Do not log them or payloads.
            warn({ module: 'tool-history', kind, reason: 'storage-error' }, 'Tool history was not saved');
        }
    });
    pendingScopes.set(scope, pending);
    try {
        await pending;
    } finally {
        pendingCount -= 1;
        const remaining = (pendingScopeCounts.get(scope) ?? 1) - 1;
        if (remaining > 0) pendingScopeCounts.set(scope, remaining);
        else pendingScopeCounts.delete(scope);
        if (pendingScopes.get(scope) === pending) pendingScopes.delete(scope);
    }
}
