/**
 * Pure helpers for rich file previews in the machine file browser: preview
 * kind detection (extension-first — the daemon has no reliable MIME source),
 * size guardrails, base64 → bytes, and the chunked fs-read assembler that
 * fetches files larger than the daemon's 512KB per-response cap as sequential
 * offset windows (each response stays under the relay's ~1MB socket payload
 * budget — the reason the per-read cap exists at all).
 *
 * No React / network imports — the assembler takes an injected chunk reader,
 * so everything here is unit-testable.
 */
import { imageMimeOf } from './fsBrowseModel';

/** What the viewer does with a file, decided by extension alone. */
export type FsPreviewKind = 'image' | 'markdown' | 'pdf' | 'text';

export function previewKindOf(path: string): FsPreviewKind {
    const base = path.split('/').pop() ?? path;
    const ext = base.includes('.') ? base.split('.').pop()!.toLowerCase() : null;
    if (ext && imageMimeOf(base)) return 'image';
    if (ext === 'md' || ext === 'markdown') return 'markdown';
    if (ext === 'pdf') return 'pdf';
    return 'text';
}

/** MIME the browser should render a preview blob as. */
export function previewMimeOf(path: string): string {
    const kind = previewKindOf(path);
    if (kind === 'pdf') return 'application/pdf';
    if (kind === 'image') return imageMimeOf(path) ?? 'application/octet-stream';
    return 'text/plain';
}

/** One fs-read response window is at most this many bytes (daemon hard cap). */
export const FS_PREVIEW_CHUNK_BYTES = 512 * 1024;
/** Binary previews (image / PDF) refuse files larger than this — assembling
 *  more than ~20 sequential relay round-trips stops being a preview. */
export const FS_PREVIEW_MAX_BYTES = 10 * 1024 * 1024;

export function base64ToBytes(b64: string): Uint8Array {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
}

export function concatBytes(parts: Uint8Array[]): Uint8Array {
    let total = 0;
    for (const p of parts) total += p.length;
    const out = new Uint8Array(total);
    let at = 0;
    for (const p of parts) {
        out.set(p, at);
        at += p.length;
    }
    return out;
}

/** Minimal shape of one fs-read chunk the assembler needs. `offset` is the
 *  daemon's echo — absent on old daemons, which is how we detect that chunked
 *  reads are unsupported over there. */
export interface FsChunk {
    ok: true;
    size: number;
    truncated: boolean;
    content: string | null;
    offset?: number | null;
}

export type FsChunkFailure = { ok: false; code: string; error: string };

export type FsAssembleResult =
    | { ok: true; bytes: Uint8Array; size: number }
    | { ok: false; code: 'too-large'; size: number }
    | { ok: false; code: 'needs-upgrade'; size: number }
    | { ok: false; code: 'chunk-failed'; failure: FsChunkFailure }
    | { ok: false; code: 'inconsistent' };

/**
 * Assemble a whole file from sequential fs-read windows.
 *
 * - Single-window files (≤ cap) work against ANY daemon (offset echo unused).
 * - Multi-window files need the daemon's `offset` echo; without it the result
 *   is 'needs-upgrade' (old daemon would re-serve offset 0 forever).
 * - `maxBytes` guard is checked on the FIRST response (which carries the full
 *   on-disk size) — oversized files cost one round-trip, not twenty.
 * - A size that changes mid-assembly (file being written) yields
 *   'inconsistent' rather than a silently corrupt preview.
 */
export async function assembleFsFile(
    readChunk: (offset: number) => Promise<FsChunk | FsChunkFailure>,
    options: { maxBytes?: number; onProgress?: (loaded: number, total: number) => void } = {},
): Promise<FsAssembleResult> {
    const maxBytes = options.maxBytes ?? FS_PREVIEW_MAX_BYTES;
    const parts: Uint8Array[] = [];
    let loaded = 0;
    let size: number | null = null;

    for (;;) {
        const res = await readChunk(loaded);
        if (!res.ok) return { ok: false, code: 'chunk-failed', failure: res };
        if (size === null) {
            size = res.size;
            if (size > maxBytes) return { ok: false, code: 'too-large', size };
        } else if (res.size !== size) {
            return { ok: false, code: 'inconsistent' };
        }
        const bytes = base64ToBytes(res.content ?? '');
        // Multi-window assembly requires the daemon to honor `offset`; the
        // echo is the proof. (First window at offset 0 needs no proof.)
        if (loaded > 0 && res.offset !== loaded) {
            return { ok: false, code: 'needs-upgrade', size };
        }
        if (res.truncated && loaded === 0 && typeof res.offset !== 'number') {
            return { ok: false, code: 'needs-upgrade', size };
        }
        parts.push(bytes);
        loaded += bytes.length;
        options.onProgress?.(loaded, size);
        if (!res.truncated) {
            return { ok: true, bytes: concatBytes(parts), size };
        }
        if (bytes.length === 0) {
            // truncated but no forward progress — refuse to spin forever
            return { ok: false, code: 'inconsistent' };
        }
    }
}
