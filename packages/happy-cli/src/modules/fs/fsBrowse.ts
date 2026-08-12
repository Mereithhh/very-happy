/**
 * Pure helpers for the machine-level file-browser RPCs (fs-list / fs-read).
 *
 * Scope note: this is a single-user daemon on the user's own machine — the
 * same daemon already runs arbitrary commands via the `bash` RPC — so there is
 * deliberately NO cwd sandbox here (unlike the session-scoped handlers in
 * modules/common). What we do provide is foolproofing: `~` expansion, path
 * normalization, NUL rejection, and clear error-code strings for the web to
 * translate ('not-found' / 'permission-denied' / 'not-a-directory' / …).
 *
 * Everything in THIS file is pure/synchronous and unit-tested; the fs I/O and
 * RPC registration live in ./fsRpc.ts.
 */
import { resolve, isAbsolute, join } from 'node:path';

/** Directory listings are capped; past this the response carries `truncated`. */
export const FS_LIST_MAX_ENTRIES = 2000;
/** fs-read never returns more than this many bytes (also the default). */
export const FS_READ_MAX_BYTES = 512 * 1024;
/** Binary sniff window: a NUL byte in the first 8KB ⇒ treat as binary. */
export const BINARY_SNIFF_BYTES = 8192;

export type FsEntryType = 'file' | 'dir' | 'symlink';

export interface FsEntry {
    name: string;
    type: FsEntryType;
    /** lstat size (symlinks report the link itself, not the target). */
    size?: number;
    mtimeMs?: number;
}

/**
 * Normalize a client-supplied path: expand `~`, resolve to an absolute
 * normalized path, reject NUL bytes / empty input. Relative paths resolve
 * against the home directory (foolproofing — the daemon's own cwd is
 * meaningless to the web client). Throws Error('invalid-path').
 */
export function normalizeFsPath(input: unknown, homeDir: string): string {
    if (typeof input !== 'string' || input.trim().length === 0) {
        throw new Error('invalid-path');
    }
    if (input.includes('\0')) {
        throw new Error('invalid-path');
    }
    let p = input.trim();
    if (p === '~') {
        p = homeDir;
    } else if (p.startsWith('~/')) {
        p = join(homeDir, p.slice(2));
    }
    if (!isAbsolute(p)) {
        p = join(homeDir, p);
    }
    return resolve(p);
}

/** NUL byte within the sniff window ⇒ binary (same heuristic git uses). */
export function isBinaryContent(bytes: Uint8Array): boolean {
    const n = Math.min(bytes.length, BINARY_SNIFF_BYTES);
    for (let i = 0; i < n; i++) {
        if (bytes[i] === 0) return true;
    }
    return false;
}

/** Sort key: directories first, then case-stable name order. Symlinks sort
 *  with files — the client can't know their target kind without following. */
export function compareFsEntries(a: Pick<FsEntry, 'name' | 'type'>, b: Pick<FsEntry, 'name' | 'type'>): number {
    const aDir = a.type === 'dir';
    const bDir = b.type === 'dir';
    if (aDir !== bDir) return aDir ? -1 : 1;
    return a.name.localeCompare(b.name);
}

/** Effective read cap: default FS_READ_MAX_BYTES, never above it, never ≤ 0. */
export function clampReadLimit(maxBytes: unknown): number {
    if (typeof maxBytes !== 'number' || !Number.isFinite(maxBytes) || maxBytes <= 0) {
        return FS_READ_MAX_BYTES;
    }
    return Math.min(Math.floor(maxBytes), FS_READ_MAX_BYTES);
}

/** Map a Dirent-like to the wire entry type. Symlink wins over everything
 *  (a Dirent for a symlink reports only isSymbolicLink()); anything that is
 *  neither dir nor symlink (regular file, fifo, socket, device) is 'file' —
 *  fs-read refuses non-regular files at read time. */
export function entryTypeOf(d: { isSymbolicLink(): boolean; isDirectory(): boolean }): FsEntryType {
    if (d.isSymbolicLink()) return 'symlink';
    if (d.isDirectory()) return 'dir';
    return 'file';
}
