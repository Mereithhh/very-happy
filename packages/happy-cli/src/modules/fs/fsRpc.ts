/**
 * Machine-level file-browser RPCs: `fs-list` and `fs-read`.
 *
 * Registered on the daemon's machine-scoped RpcHandlerManager (apiMachine),
 * so the web can browse any directory / read any file on the machine — the
 * "claude said it wrote a file, let me SEE it" flow, for both terminal
 * sessions and chat sessions. Account scoping is enforced by the server (RPC
 * rooms are per-account) and the payloads ride the existing E2E RPC channel.
 *
 * No cwd sandbox by design (single-user daemon that already exposes `bash`);
 * see fsBrowse.ts for the foolproofing that IS done. Failures are thrown as
 * Error with a stable code string ('not-found' / 'permission-denied' /
 * 'not-a-directory' / 'not-a-file' / 'invalid-path'), which
 * RpcHandlerManager encodes as `{ error }` — note the B-003 gotcha: that
 * arrives at the web as a NORMAL response, so the web ops wrapper must check
 * the `error` field explicitly.
 */
import { readdir, stat, lstat, open } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { logger } from '@/ui/logger';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import {
    FS_LIST_MAX_ENTRIES,
    clampReadLimit,
    clampReadOffset,
    compareFsEntries,
    entryTypeOf,
    isBinaryContent,
    normalizeFsPath,
    type FsEntry,
} from './fsBrowse';

export interface FsListResponse {
    /** Normalized absolute path actually listed (after ~ expansion). */
    path: string;
    entries: FsEntry[];
    /** True when the directory has more than FS_LIST_MAX_ENTRIES entries. */
    truncated: boolean;
}

export interface FsReadResponse {
    /** Normalized absolute path actually read. */
    path: string;
    /** Full on-disk size in bytes (may exceed what `content` carries). */
    size: number;
    /** NUL byte in the first 8KB of the returned window ⇒ binary; no content
     *  is returned then (unless `allowBinary`). */
    binary: boolean;
    /** True when bytes remain past the returned window (offset + content). */
    truncated: boolean;
    /** base64 file bytes (up to the cap). Absent for binary files unless the
     *  caller opted in with `allowBinary` (web image preview). */
    content?: string;
    /** Echo of the effective read start. Presence tells the web this daemon
     *  supports chunked reads (old daemons omit it — old WEBS ignore it). */
    offset: number;
}

export interface FsReadOptions {
    maxBytes?: unknown;
    /** Return content even for binary files (still capped) — the web asks for
     *  this on image extensions to render an inline preview. */
    allowBinary?: boolean;
    /** Byte position to start reading from (default 0). The web assembles
     *  large previews (PDF / big images) from sequential ≤512KB chunks so each
     *  RPC response stays under the relay's payload budget. */
    offset?: unknown;
}

/** Map fs errno failures to stable code strings; our own code-string Errors
 *  (invalid-path / not-a-directory / not-a-file) pass through unchanged. */
function fsError(error: unknown): Error {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return new Error('not-found');
    if (code === 'EACCES' || code === 'EPERM') return new Error('permission-denied');
    if (error instanceof Error) return error;
    return new Error('fs-failed');
}

/** List one directory. Entries are lstat'ed individually (a broken symlink or
 *  a permission-denied child must not fail the whole listing — it just loses
 *  size/mtime). Sorted dirs-first for deterministic truncation; the web
 *  re-sorts for display anyway. */
export async function fsList(inputPath: unknown, homeDir: string = homedir()): Promise<FsListResponse> {
    const path = normalizeFsPath(inputPath, homeDir);
    let dirents;
    try {
        const st = await stat(path); // follows symlinks: listing a symlinked dir works
        if (!st.isDirectory()) throw new Error('not-a-directory');
        dirents = await readdir(path, { withFileTypes: true });
    } catch (error) {
        throw fsError(error);
    }
    const entries: FsEntry[] = await Promise.all(
        dirents.map(async (d) => {
            const entry: FsEntry = { name: d.name, type: entryTypeOf(d) };
            try {
                const s = await lstat(join(path, d.name));
                entry.size = s.size;
                entry.mtimeMs = Math.round(s.mtimeMs);
            } catch {
                // best-effort metadata — keep the row
            }
            return entry;
        }),
    );
    entries.sort(compareFsEntries);
    const truncated = entries.length > FS_LIST_MAX_ENTRIES;
    return {
        path,
        entries: truncated ? entries.slice(0, FS_LIST_MAX_ENTRIES) : entries,
        truncated,
    };
}

/** Read one regular file window, capped at clampReadLimit(maxBytes) bytes
 *  (512KB hard max) starting at clampReadOffset(offset). Only regular files
 *  are read — directories, fifos, sockets and devices are refused
 *  ('not-a-file'), so a fifo can never hang the daemon. */
export async function fsRead(inputPath: unknown, options: FsReadOptions = {}, homeDir: string = homedir()): Promise<FsReadResponse> {
    const path = normalizeFsPath(inputPath, homeDir);
    const limit = clampReadLimit(options.maxBytes);
    const offset = clampReadOffset(options.offset);
    try {
        const st = await stat(path); // follows symlinks: reading a symlinked file works
        if (!st.isFile()) throw new Error('not-a-file');
        const fh = await open(path, 'r');
        try {
            const fst = await fh.stat(); // fresh size from the open handle
            const size = fst.size;
            const want = Math.min(Math.max(size - offset, 0), limit);
            const buf = Buffer.alloc(want);
            const { bytesRead } = buf.length > 0 ? await fh.read(buf, 0, buf.length, offset) : { bytesRead: 0 };
            const bytes = buf.subarray(0, bytesRead);
            const truncated = size > offset + bytesRead;
            // Binary sniff is only meaningful on the window we actually looked
            // at; chunked callers (offset > 0) always pass allowBinary anyway.
            if (isBinaryContent(bytes)) {
                if (options.allowBinary === true) {
                    return { path, size, binary: true, truncated, content: bytes.toString('base64'), offset };
                }
                return { path, size, binary: true, truncated: false, offset };
            }
            return { path, size, binary: false, truncated, content: bytes.toString('base64'), offset };
        } finally {
            await fh.close();
        }
    } catch (error) {
        throw fsError(error);
    }
}

/** Register the two machine-level file-browser RPCs. */
export function registerFsHandlers(rpcHandlerManager: RpcHandlerManager): void {
    rpcHandlerManager.registerHandler<{ path: string }, FsListResponse>('fs-list', async (params) => {
        logger.debug('[FS RPC] fs-list', params?.path);
        return fsList(params?.path);
    });

    rpcHandlerManager.registerHandler<{ path: string; maxBytes?: number; allowBinary?: boolean; offset?: number }, FsReadResponse>('fs-read', async (params) => {
        logger.debug('[FS RPC] fs-read', params?.path);
        return fsRead(params?.path, { maxBytes: params?.maxBytes, allowBinary: params?.allowBinary === true, offset: params?.offset });
    });
}
