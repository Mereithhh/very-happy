import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
    acquireSessionLock,
    liveSessionLockHolder,
    readSessionLock,
    releaseSessionLock,
    sessionLockPath,
    type SessionLockRuntime,
} from './sessionLock';

const SESSION = 'cmtcqxdtu007vqh2a8m7ztix7';

function makeRuntime(dir: string, alive: Set<number>, selfPid = 17092) {
    const signals: Array<{ pid: number; signal: string }> = [];
    const scheduled: Array<() => void> = [];
    const runtime: SessionLockRuntime = {
        dir,
        selfPid,
        now: () => 1_700_000_000_000,
        isAlive: (pid) => alive.has(pid),
        signal: (pid, signal) => {
            if (!alive.has(pid)) throw new Error('ESRCH');
            signals.push({ pid, signal });
        },
        schedule: (cb) => { scheduled.push(cb); },
    };
    const runScheduled = () => { const next = scheduled.shift(); next?.(); };
    return { runtime, signals, runScheduled };
}

describe('sessionLock', () => {
    let dir: string;
    beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'vh-session-lock-')); });
    afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

    it('acquires a free session and records this process', async () => {
        const { runtime } = makeRuntime(dir, new Set());
        await expect(acquireSessionLock(SESSION, { takeover: false, version: '0.2.95', flavor: 'claude' }, runtime))
            .resolves.toEqual({ ok: true, replaced: null });
        expect(readSessionLock(SESSION, dir)).toEqual({ pid: 17092, startedAt: 1_700_000_000_000, version: '0.2.95', flavor: 'claude' });
        expect(JSON.parse(readFileSync(sessionLockPath(SESSION, dir), 'utf-8')).pid).toBe(17092);
    });

    it('yields to a live holder when takeover is off', async () => {
        const alive = new Set([25691]);
        const { runtime, signals } = makeRuntime(dir, alive);
        writeFileSync(sessionLockPath(SESSION, dir), JSON.stringify({ pid: 25691, startedAt: 1, version: '0.2.93' }));
        const result = await acquireSessionLock(SESSION, { takeover: false, version: '0.2.95' }, runtime);
        expect(result).toEqual({ ok: false, holder: { pid: 25691, startedAt: 1, version: '0.2.93' } });
        expect(signals).toEqual([]);
        expect(readSessionLock(SESSION, dir)?.pid).toBe(25691);
    });

    it('overwrites a stale record whose holder is dead', async () => {
        const { runtime } = makeRuntime(dir, new Set());
        writeFileSync(sessionLockPath(SESSION, dir), JSON.stringify({ pid: 94251, startedAt: 1, version: '0.2.84' }));
        await expect(acquireSessionLock(SESSION, { takeover: false, version: '0.2.95' }, runtime)).resolves.toEqual({ ok: true, replaced: null });
        expect(readSessionLock(SESSION, dir)?.pid).toBe(17092);
    });

    it('takeover terminates the live holder, waits for it to be gone, then takes the lock (B-272 incident shape)', async () => {
        const alive = new Set([25691]);
        const { runtime, signals, runScheduled } = makeRuntime(dir, alive);
        writeFileSync(sessionLockPath(SESSION, dir), JSON.stringify({ pid: 25691, startedAt: 1, version: '0.2.93' }));
        const pending = acquireSessionLock(SESSION, { takeover: true, version: '0.2.95' }, runtime);
        expect(signals).toEqual([{ pid: 25691, signal: 'SIGTERM' }]);
        // The lock is NOT taken while the holder is still alive.
        expect(readSessionLock(SESSION, dir)?.pid).toBe(25691);
        alive.delete(25691);          // holder exits within the grace period
        runScheduled();               // grace timer → no SIGKILL needed
        runScheduled();               // settle
        await expect(pending).resolves.toEqual({ ok: true, replaced: { pid: 25691, startedAt: 1, version: '0.2.93' } });
        expect(signals).toEqual([{ pid: 25691, signal: 'SIGTERM' }]);
        expect(readSessionLock(SESSION, dir)?.pid).toBe(17092);
    });

    it('takeover escalates to SIGKILL and still yields when the holder survives', async () => {
        const alive = new Set([25691]);
        const { runtime, signals, runScheduled } = makeRuntime(dir, alive);
        writeFileSync(sessionLockPath(SESSION, dir), JSON.stringify({ pid: 25691, startedAt: 1, version: '0.2.93' }));
        const pending = acquireSessionLock(SESSION, { takeover: true, version: '0.2.95' }, runtime);
        runScheduled();               // grace → SIGKILL
        expect(signals.map((s) => s.signal)).toEqual(['SIGTERM', 'SIGKILL']);
        runScheduled();               // settle: still alive
        await expect(pending).resolves.toEqual({ ok: false, holder: { pid: 25691, startedAt: 1, version: '0.2.93' } });
        expect(readSessionLock(SESSION, dir)?.pid).toBe(25691);
    });

    it('re-acquiring our own lock is a no-op success', async () => {
        const { runtime } = makeRuntime(dir, new Set([17092]));
        await acquireSessionLock(SESSION, { takeover: false, version: '0.2.95' }, runtime);
        await expect(acquireSessionLock(SESSION, { takeover: false, version: '0.2.95' }, runtime)).resolves.toEqual({ ok: true, replaced: null });
        expect(liveSessionLockHolder(SESSION, runtime)).toBeNull();
    });

    it('release only removes our own record', async () => {
        const { runtime } = makeRuntime(dir, new Set([25691]));
        writeFileSync(sessionLockPath(SESSION, dir), JSON.stringify({ pid: 25691, startedAt: 1, version: '0.2.93' }));
        releaseSessionLock(SESSION, runtime);
        expect(readSessionLock(SESSION, dir)?.pid).toBe(25691);
        writeFileSync(sessionLockPath(SESSION, dir), JSON.stringify({ pid: 17092, startedAt: 1, version: '0.2.95' }));
        releaseSessionLock(SESSION, runtime);
        expect(readSessionLock(SESSION, dir)).toBeNull();
        releaseSessionLock(SESSION, runtime); // idempotent
    });

    it('treats garbage on disk as no lock', () => {
        writeFileSync(sessionLockPath(SESSION, dir), '{not json');
        expect(readSessionLock(SESSION, dir)).toBeNull();
        writeFileSync(sessionLockPath(SESSION, dir), JSON.stringify({ pid: -1 }));
        expect(readSessionLock(SESSION, dir)).toBeNull();
        expect(readSessionLock('missing', dir)).toBeNull();
    });
});
