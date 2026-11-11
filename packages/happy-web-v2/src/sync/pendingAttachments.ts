/**
 * B-929: the files of a pending session's outbox (sync/pendingSessions.ts).
 *
 * The record in localStorage only describes them; the bytes live here, keyed
 * by the outbox item id: in memory as the composer's Blob URLs (no copy while
 * the tab lives) and in IndexedDB as Blobs, so a reload or a closed tab whose
 * record another tab reclaims still sends them. A file that is in neither (the
 * IndexedDB write failed, private mode) reads as lost — the caller says so and
 * returns the text; it never goes out silently without them.
 */
import { createStore, del, entries, get, set, type UseStore } from 'idb-keyval';
import type { AttachmentPreview } from './attachmentTypes';
import { AttachmentSendError, sessionAcceptsAttachments } from './attachmentCapabilities';

type StoredFile = Omit<AttachmentPreview, 'uri'> & { blob: Blob };

const memory = new Map<string, AttachmentPreview[]>();
/** IndexedDB writes in flight — a release waits for its write before deleting. */
const writes = new Map<string, Promise<void>>();
let idbStore: UseStore | null | undefined;

function idb(): UseStore | null {
    if (idbStore !== undefined) return idbStore;
    try {
        idbStore = typeof indexedDB === 'undefined' ? null : createStore('vh-pending-attachments', 'files');
    } catch {
        idbStore = null;
    }
    return idbStore;
}

function revoke(items: readonly AttachmentPreview[]): void {
    for (const item of items) {
        if (item.uri.startsWith('blob:')) {
            try { URL.revokeObjectURL(item.uri); } catch { /* ignore */ }
        }
    }
}

async function persist(itemId: string, items: AttachmentPreview[]): Promise<void> {
    const store = idb();
    if (!store) return;
    try {
        const files: StoredFile[] = [];
        for (const { uri, ...meta } of items) files.push({ ...meta, blob: await (await fetch(uri)).blob() });
        // Released while reading: do not resurrect it.
        if (!memory.has(itemId)) return;
        await set(itemId, files, store);
    } catch (error) {
        console.warn('[pending-attachments] could not keep a copy for reload', error);
    }
}

/** Take ownership of `items` (their Blob URLs) for outbox item `itemId`. */
export function holdPendingAttachments(itemId: string, items: AttachmentPreview[]): void {
    if (items.length === 0) return;
    memory.set(itemId, items);
    const write = persist(itemId, items).finally(() => { if (writes.get(itemId) === write) writes.delete(itemId); });
    writes.set(itemId, write);
}

/** The files of `itemId` (memory first, then the stored copy). Null = not kept anywhere. */
export async function loadPendingAttachments(itemId: string): Promise<AttachmentPreview[] | null> {
    const held = memory.get(itemId);
    if (held) return held;
    const store = idb();
    if (!store) return null;
    try {
        const files = await get<StoredFile[]>(itemId, store);
        if (!Array.isArray(files) || files.length === 0) return null;
        const items = files.map(({ blob, ...meta }) => ({ ...meta, uri: URL.createObjectURL(blob) }));
        memory.set(itemId, items);
        return items;
    } catch (error) {
        console.warn('[pending-attachments] could not read the stored copy', error);
        return null;
    }
}

/**
 * Hand the files of `itemIds` to someone else (the composer): they own the
 * Blob URLs from here on, nothing is revoked. Missing ones are counted.
 */
export async function takePendingAttachments(itemIds: readonly string[]): Promise<{ items: AttachmentPreview[]; lost: number }> {
    const items: AttachmentPreview[] = [];
    let lost = 0;
    for (const id of itemIds) {
        const files = await loadPendingAttachments(id);
        if (files) items.push(...files);
        else lost++;
        memory.delete(id);
        void forget(id);
    }
    return { items, lost };
}

async function forget(itemId: string): Promise<void> {
    await writes.get(itemId);
    const store = idb();
    if (!store) return;
    try { await del(itemId, store); } catch { /* ignore */ }
}

/** The files of `itemIds` are not needed any more (sent, removed, discarded). */
export function releasePendingAttachments(itemIds: readonly string[]): void {
    for (const id of itemIds) {
        const held = memory.get(id);
        memory.delete(id);
        if (held) revoke(held);
        void forget(id);
    }
}

/** Drop stored copies no outbox item refers to any more (records gone while this tab was closed). */
export async function sweepPendingAttachments(liveItemIds: ReadonlySet<string>): Promise<void> {
    const store = idb();
    if (!store) return;
    try {
        for (const [key] of await entries(store)) {
            if (typeof key === 'string' && !liveItemIds.has(key) && !memory.has(key)) await del(key, store);
        }
    } catch (error) {
        console.warn('[pending-attachments] sweep failed', error);
    }
}

type FileMeta = { mimeType: string; name: string };

/**
 * B-929: send one pending outbox item — text plus, when it has any, all of its
 * files — to the real session. Checked against the real session first (a
 * pending page only guessed from the agent); the files must all go or none
 * (`strict`). Any refusal is said through `say` and rethrown, so the store
 * hands text + files back to the composer.
 */
export async function sendPendingItem(io: {
    metadata: { flavor?: string | null; attachmentKinds?: string[] } | null | undefined;
    send: (attachments?: AttachmentPreview[]) => Promise<unknown>;
    say: (kind: AttachmentSendError['kind']) => void;
}, localId: string, files: readonly FileMeta[] | undefined): Promise<unknown> {
    try {
        if (!files?.length) return await io.send();
        if (!sessionAcceptsAttachments(io.metadata, files)) throw new AttachmentSendError('unsupported');
        const attachments = await loadPendingAttachments(localId);
        if (!attachments || attachments.length < files.length) throw new AttachmentSendError('lost');
        return await io.send(attachments);
    } catch (error) {
        if (error instanceof AttachmentSendError) io.say(error.kind);
        throw error;
    }
}

/** @internal tests */
export function resetPendingAttachmentsForTest(): void {
    memory.clear();
    writes.clear();
    idbStore = undefined;
}
