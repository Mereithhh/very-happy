/**
 * Machine file-browser RPC wrappers (fs-list / fs-read) — the web side of the
 * daemon's modules/fs/fsRpc.ts.
 *
 * B-003 gotcha handled here: a daemon-side handler failure is encoded by
 * RpcHandlerManager as `{ error }` inside a relay-level OK response, so
 * machineRPC resolves "successfully" with an error object — every wrapper
 * checks the `error` field explicitly instead of trusting the resolve.
 *
 * Protocol compat: a daemon that predates these RPCs never registered the
 * method, so the SERVER answers `RPC method not available` (the same string
 * an offline daemon produces — the two are indistinguishable from here) and
 * a hypothetical registered-but-missing handler answers `Method not found`.
 * Both map to code 'unsupported' so the UI can show the "machine offline or
 * daemon needs ≥ 0.2.33" hint instead of a raw error.
 */
import { apiSocket } from './apiSocket';
import { ensureMachineEncryption } from './ops';

export type FsEntryType = 'file' | 'dir' | 'symlink';

export interface FsEntry {
    name: string;
    type: FsEntryType;
    size?: number;
    mtimeMs?: number;
}

export type FsFailureCode =
    | 'unsupported'
    | 'not-found'
    | 'permission-denied'
    | 'not-a-directory'
    | 'not-a-file'
    | 'invalid-path'
    | 'unknown';

export interface FsFailure {
    ok: false;
    code: FsFailureCode;
    error: string;
}

export type FsListResult =
    | { ok: true; path: string; entries: FsEntry[]; truncated: boolean }
    | FsFailure;

export type FsReadResult =
    | { ok: true; path: string; size: number; binary: boolean; truncated: boolean; content: string | null }
    | FsFailure;

const KNOWN_CODES: ReadonlySet<string> = new Set([
    'not-found', 'permission-denied', 'not-a-directory', 'not-a-file', 'invalid-path',
]);

function failureOf(error: string): FsFailure {
    // Old daemon (method never registered → server-side "not available") or a
    // daemon-side "Method not found": the feature doesn't exist over there.
    if (error === 'RPC method not available' || error === 'Method not found') {
        return { ok: false, code: 'unsupported', error };
    }
    if (KNOWN_CODES.has(error)) {
        return { ok: false, code: error as FsFailureCode, error };
    }
    return { ok: false, code: 'unknown', error };
}

/** List a directory on the machine. `path` may use `~`. Never throws. */
export async function machineFsList(machineId: string, path: string): Promise<FsListResult> {
    try {
        // Cold-load race guard (same as machineOpenTerminal): don't fire before
        // the machine's encryption key has synced.
        await ensureMachineEncryption(machineId);
        const res = await apiSocket.machineRPC<
            { path: string; entries: FsEntry[]; truncated: boolean } & { error?: string },
            { path: string }
        >(machineId, 'fs-list', { path });
        if (typeof res?.error === 'string') return failureOf(res.error);
        if (!res || typeof res.path !== 'string' || !Array.isArray(res.entries)) {
            return { ok: false, code: 'unknown', error: 'Malformed fs-list response' };
        }
        return { ok: true, path: res.path, entries: res.entries, truncated: res.truncated === true };
    } catch (error) {
        return failureOf(error instanceof Error ? error.message : 'fs-list failed');
    }
}

/** Read a file on the machine (≤ 512KB; binary detected daemon-side).
 *  `allowBinary` asks the daemon to include binary bytes anyway (image
 *  preview). Never throws. */
export async function machineFsRead(
    machineId: string,
    path: string,
    options: { maxBytes?: number; allowBinary?: boolean } = {},
): Promise<FsReadResult> {
    try {
        await ensureMachineEncryption(machineId);
        const res = await apiSocket.machineRPC<
            { path: string; size: number; binary: boolean; truncated: boolean; content?: string } & { error?: string },
            { path: string; maxBytes?: number; allowBinary?: boolean }
        >(machineId, 'fs-read', { path, maxBytes: options.maxBytes, allowBinary: options.allowBinary });
        if (typeof res?.error === 'string') return failureOf(res.error);
        if (!res || typeof res.path !== 'string' || typeof res.size !== 'number') {
            return { ok: false, code: 'unknown', error: 'Malformed fs-read response' };
        }
        return {
            ok: true,
            path: res.path,
            size: res.size,
            binary: res.binary === true,
            truncated: res.truncated === true,
            content: typeof res.content === 'string' ? res.content : null,
        };
    } catch (error) {
        return failureOf(error instanceof Error ? error.message : 'fs-read failed');
    }
}
