/**
 * B-961b: retry / edit with attachments, without asking the user for the file
 * again.
 *
 * A filed `file` event carries a server `ref`; the machine staged the bytes
 * under `HAPPY_HOME/uploads/chat/<session>/`. Two places need that fact:
 *  - the live `file` event handler reuses the staged copy when the same ref is
 *    sent again (edit / retry), instead of downloading and writing a duplicate;
 *  - the `conversation-rewind` RPC checks every ref BEFORE it rewinds anything:
 *    staged copy → reuse, otherwise fetch the blob → stage, and only when both
 *    fail does it refuse (`attachment-gone`), naming the files. Nothing is
 *    dropped from the conversation on a refusal.
 */
import type { DownloadedAttachment } from '@/api/apiSession';
import type { StagedAttachment } from '@/claude/utils/attachmentContent';
import { lookupMachineAttachment } from './attachmentRegistry';

export type RewindAttachmentRef = {
    ref: string;
    name: string;
    size?: number;
    mimeType?: string;
};

export type RewindAttachmentDeps = {
    happyHomeDir: string;
    sessionId: string;
    /** Download + decrypt one blob; null when it cannot be resolved. */
    download: (ref: string) => Promise<Uint8Array | null>;
    /** Persist decrypted bytes (records the ref → path map itself). */
    stage: (attachments: Array<{ data: Uint8Array; mimeType: string; name: string; ref?: string; path?: string }>) => Promise<StagedAttachment[]>;
};

export type RewindAttachmentResult =
    | { ok: true; attachments: StagedAttachment[] }
    | { ok: false; missing: string[] };

/** Parse the optional `attachments` array of a rewind request. Pure. */
export function parseRewindAttachments(value: unknown): RewindAttachmentRef[] {
    if (!Array.isArray(value)) return [];
    const out: RewindAttachmentRef[] = [];
    for (const item of value.slice(0, 20)) {
        if (!item || typeof item !== 'object') continue;
        const record = item as Record<string, unknown>;
        const ref = typeof record.ref === 'string' ? record.ref.trim() : '';
        if (!ref || ref.length > 512) continue;
        out.push({
            ref,
            name: typeof record.name === 'string' && record.name.trim() ? record.name.trim().slice(0, 200) : 'attachment',
            ...(typeof record.size === 'number' && Number.isFinite(record.size) ? { size: record.size } : {}),
            ...(typeof record.mimeType === 'string' && record.mimeType.trim() ? { mimeType: record.mimeType.trim() } : {}),
        });
    }
    // The same ref twice is one file.
    const seen = new Set<string>();
    return out.filter((attachment) => (seen.has(attachment.ref) ? false : (seen.add(attachment.ref), true)));
}

/** One `file` event: the staged copy if this machine has it, else a download. */
export async function resolveFileEventAttachment(
    deps: Pick<RewindAttachmentDeps, 'happyHomeDir' | 'sessionId' | 'download'>,
    ev: { ref: string; name: string; mimeType?: string },
): Promise<DownloadedAttachment | null> {
    const staged = await lookupMachineAttachment(deps.happyHomeDir, deps.sessionId, ev.ref);
    if (staged) {
        return {
            data: new Uint8Array(0),
            mimeType: ev.mimeType ?? staged.mimeType,
            name: ev.name || staged.name,
            ref: ev.ref,
            path: staged.path,
        };
    }
    try {
        const data = await deps.download(ev.ref);
        if (!data) return null;
        return { data, mimeType: ev.mimeType ?? 'image/jpeg', name: ev.name, ref: ev.ref };
    } catch {
        return null;
    }
}

/**
 * Resolve every attachment a rewind is about to re-send. A ref that resolves
 * neither from the machine nor from the server makes the whole request fail —
 * the caller refuses before anything is rewound.
 */
export async function ensureRewindAttachments(
    deps: RewindAttachmentDeps,
    refs: readonly RewindAttachmentRef[],
): Promise<RewindAttachmentResult> {
    const resolved: Array<{ data: Uint8Array; mimeType: string; name: string; ref?: string; path?: string }> = [];
    const missing: string[] = [];
    for (const ref of refs) {
        const staged = await lookupMachineAttachment(deps.happyHomeDir, deps.sessionId, ref.ref);
        if (staged) {
            resolved.push({ data: new Uint8Array(0), mimeType: ref.mimeType ?? staged.mimeType, name: staged.name, ref: ref.ref, path: staged.path });
            continue;
        }
        try {
            const data = await deps.download(ref.ref);
            if (!data) {
                missing.push(ref.name);
                continue;
            }
            resolved.push({ data, mimeType: ref.mimeType ?? 'application/octet-stream', name: ref.name, ref: ref.ref });
        } catch {
            missing.push(ref.name);
        }
    }
    if (missing.length > 0) return { ok: false, missing };
    if (resolved.length === 0) return { ok: true, attachments: [] };
    try {
        const attachments = await deps.stage(resolved);
        return { ok: true, attachments };
    } catch {
        return { ok: false, missing: refs.map((ref) => ref.name) };
    }
}

/** The refusal message the Web shows verbatim. */
export function attachmentGoneMessage(missing: readonly string[]): string {
    return missing.length === 0
        ? 'The attachments are no longer available on this machine'
        : `The attachments are no longer available on this machine: ${missing.join(', ')}`;
}

/**
 * B-961c: one prompt carries a ref once. An older Web re-sent a retried
 * prompt's file events doubled (the old ones stayed on screen and joined the
 * new run), and every copy went to the model. Pure.
 */
export function uniqueAttachmentsByRef(attachments: DownloadedAttachment[]): DownloadedAttachment[] {
    const seen = new Set<string>();
    return attachments.filter((attachment) => {
        if (!attachment.ref) return true;
        if (seen.has(attachment.ref)) return false;
        seen.add(attachment.ref);
        return true;
    });
}
