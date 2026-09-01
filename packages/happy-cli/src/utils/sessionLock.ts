/**
 * B-272: single-writer lock for a happy session on this machine.
 *
 * Invariant: at most ONE live wrapper process (`happy claude|codex …`) drives
 * a given happy session. Two wrappers on one session are two SDK runs on one
 * conversation — every prompt executed and rendered twice, thinking traces
 * and permission modes fighting each other. The daemon's in-memory pid table
 * cannot guarantee this by itself (it is rebuilt from a persisted `hostPid`
 * across daemon handovers and can go stale), so the invariant is enforced by
 * the party that actually knows: the wrapper, at startup, before it touches
 * the server.
 *
 *   ~/.happy/session-locks/<happySessionId>.json  → { pid, startedAt, version, flavor }
 *
 * - Fresh session (id just minted): acquire is trivially free.
 * - Reconnect (HAPPY_RECONNECT_*, i.e. resume/restart): the intent is to
 *   REPLACE whatever runs the session. The newcomer terminates the holder,
 *   waits for it to be gone, and only then takes the lock — ordering matters
 *   because a wrapper's shutdown deactivates the row on the server, which
 *   broadcasts an archive that would take a connected successor down too.
 * - Holder that cannot be terminated: the newcomer yields (exits without
 *   ever connecting), never becoming a second writer.
 * - Stale records (holder pid dead — SIGKILL, crash, codex without a SIGTERM
 *   handler) are simply overwritten; liveness is `kill(pid, 0)`, the same
 *   verification the daemon uses.
 *
 * The daemon reads these records as the source of truth for "which pid runs
 * session X" (adoption after a handover, stop-before-relaunch), falling back
 * to `hostPid` / command-line matching only for wrappers older than the lock.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';
import { terminateProcess, type ProcessTerminationRuntime } from '@/daemon/processTermination';
import { writePrivateFileSync } from '@/utils/secureFiles';

export const SESSION_LOCK_DIR = 'session-locks';

export interface SessionLockRecord {
    pid: number;
    startedAt: number;
    version: string;
    flavor?: string;
}

export interface SessionLockRuntime extends ProcessTerminationRuntime {
    /** Directory holding the lock files (default `<happyHomeDir>/session-locks`). */
    dir: string;
    /** This process's pid. */
    selfPid: number;
    now(): number;
}

const defaultRuntime = (): SessionLockRuntime => ({
    dir: join(configuration.happyHomeDir, SESSION_LOCK_DIR),
    selfPid: process.pid,
    now: () => Date.now(),
    signal: (pid, signal) => process.kill(pid, signal),
    isAlive: (pid) => {
        try {
            process.kill(pid, 0);
            return true;
        } catch {
            return false;
        }
    },
    schedule: (callback, delayMs) => { setTimeout(callback, delayMs); },
});

export function sessionLockPath(happySessionId: string, dir = join(configuration.happyHomeDir, SESSION_LOCK_DIR)): string {
    return join(dir, `${happySessionId}.json`);
}

/** The record on disk, or null when absent / unparsable. Says nothing about liveness. */
export function readSessionLock(happySessionId: string, dir?: string): SessionLockRecord | null {
    try {
        const path = sessionLockPath(happySessionId, dir);
        if (!existsSync(path)) return null;
        const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<SessionLockRecord>;
        if (typeof parsed?.pid !== 'number' || !Number.isInteger(parsed.pid) || parsed.pid <= 0) return null;
        return {
            pid: parsed.pid,
            startedAt: typeof parsed.startedAt === 'number' ? parsed.startedAt : 0,
            version: typeof parsed.version === 'string' ? parsed.version : '',
            ...(typeof parsed.flavor === 'string' ? { flavor: parsed.flavor } : {}),
        };
    } catch {
        return null;
    }
}

/** The record if its holder is a live process other than `selfPid`, else null. */
export function liveSessionLockHolder(
    happySessionId: string,
    runtime: Pick<SessionLockRuntime, 'dir' | 'isAlive' | 'selfPid'> = defaultRuntime(),
): SessionLockRecord | null {
    const record = readSessionLock(happySessionId, runtime.dir);
    if (!record || record.pid === runtime.selfPid) return null;
    return runtime.isAlive(record.pid) ? record : null;
}

function writeSessionLock(happySessionId: string, record: SessionLockRecord, dir: string): void {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = sessionLockPath(happySessionId, dir);
    const tmp = `${path}.${record.pid}.tmp`;
    writePrivateFileSync(tmp, JSON.stringify(record));
    renameSync(tmp, path);
}

export type AcquireSessionLockResult =
    | { ok: true; replaced: SessionLockRecord | null }
    | { ok: false; holder: SessionLockRecord };

/**
 * Take the session's lock for this process.
 *
 * `takeover: false` — yield to a live holder.
 * `takeover: true`  — terminate the live holder (SIGTERM → grace → SIGKILL),
 * wait until it is gone, then take the lock. Still yields if the holder
 * survives every attempt.
 */
export function acquireSessionLock(
    happySessionId: string,
    options: { takeover: boolean; version: string; flavor?: string; graceMs?: number },
    runtime: SessionLockRuntime = defaultRuntime(),
): Promise<AcquireSessionLockResult> {
    const record = (): SessionLockRecord => ({
        pid: runtime.selfPid,
        startedAt: runtime.now(),
        version: options.version,
        ...(options.flavor ? { flavor: options.flavor } : {}),
    });

    const holder = liveSessionLockHolder(happySessionId, runtime);
    if (!holder) {
        writeSessionLock(happySessionId, record(), runtime.dir);
        return Promise.resolve({ ok: true, replaced: null });
    }
    if (!options.takeover) {
        return Promise.resolve({ ok: false, holder });
    }
    return new Promise((resolve) => {
        const requested = terminateProcess(holder.pid, (stopped) => {
            if (!stopped) {
                resolve({ ok: false, holder });
                return;
            }
            writeSessionLock(happySessionId, record(), runtime.dir);
            resolve({ ok: true, replaced: holder });
        }, runtime, options.graceMs ?? 2_000);
        if (!requested) resolve({ ok: false, holder });
    });
}

/** Remove the record — only when it is ours. Safe to call repeatedly. */
export function releaseSessionLock(
    happySessionId: string,
    runtime: Pick<SessionLockRuntime, 'dir' | 'selfPid'> = defaultRuntime(),
): void {
    try {
        const record = readSessionLock(happySessionId, runtime.dir);
        if (record && record.pid === runtime.selfPid) {
            unlinkSync(sessionLockPath(happySessionId, runtime.dir));
        }
    } catch {
        // best effort — a stale record is harmless (holder pid is dead)
    }
}

/**
 * Wrapper entry point: claim the session for this process or exit(0) without
 * ever connecting. Registers the release on process exit. Idempotent per id.
 */
export async function claimSessionOrExit(
    happySessionId: string,
    options: { takeover: boolean; flavor: string },
): Promise<void> {
    const result = await acquireSessionLock(happySessionId, {
        takeover: options.takeover,
        version: configuration.currentCliVersion,
        flavor: options.flavor,
    });
    if (!result.ok) {
        const message = `Session ${happySessionId} is already run by very-happy pid ${result.holder.pid} (v${result.holder.version || '?'}); this process yields.`;
        logger.debug(`[SESSION LOCK] ${message}`);
        console.error(message);
        process.exit(0);
    }
    if (result.replaced) {
        logger.debug(`[SESSION LOCK] Took over session ${happySessionId} from pid ${result.replaced.pid} (v${result.replaced.version || '?'})`);
    }
    process.on('exit', () => releaseSessionLock(happySessionId));
}
