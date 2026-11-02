import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

function makeRuntime(dir: string, alive: Set<number>, selfPid = 17092, tree: SessionLockRuntime['tree'] = { snapshot: () => [], readLive: () => [] }) {
    const signals: Array<{ pid: number; signal: string }> = [];
    const scheduled: Array<() => void> = [];
    const runtime: SessionLockRuntime = {
        // Fake pids: never let the takeover's tree stop read (or SIGKILL) the real process table.
        tree,
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

    it('B-864b: a takeover that needs the SIGKILL also stops the holder\'s Claude Code tree', async () => {
        const alive = new Set([25691]);
        const claude = { pid: 25700, ppid: 25691, start: 'Mon Nov  2 10:00:00 2026' };
        const mcp = { pid: 25710, ppid: 25700, start: 'Mon Nov  2 10:00:01 2026' };
        let table = [claude, mcp];
        const snapshots: number[] = [];
        const reaped: number[][] = [];
        const { runtime, signals, runScheduled } = makeRuntime(dir, alive, 17092, {
            snapshot: (pid) => { snapshots.push(pid); return [...table]; },
            reap: (entries) => { reaped.push(entries.map((e) => e.pid)); table = []; return entries.map((e) => e.pid); },
            readLive: () => table,
        });
        writeFileSync(sessionLockPath(SESSION, dir), JSON.stringify({ pid: 25691, startedAt: 1, version: '0.2.93' }));
        const pending = acquireSessionLock(SESSION, { takeover: true, version: '0.2.95' }, runtime);
        runScheduled();               // grace: the wrapper ignored SIGTERM → re-snapshot, SIGKILL
        expect(signals.map((s) => s.signal)).toEqual(['SIGTERM', 'SIGKILL']);
        expect(snapshots).toEqual([25691, 25691]);
        alive.delete(25691);          // the SIGKILL landed; its children did not get it
        runScheduled();               // settle → reap the tree, verify it is gone
        await expect(pending).resolves.toEqual({ ok: true, replaced: { pid: 25691, startedAt: 1, version: '0.2.93' } });
        expect(reaped).toEqual([[25700, 25710]]);
        expect(readSessionLock(SESSION, dir)?.pid).toBe(17092);
    });

    it('B-864b: a holder tree that survives the reap fails the takeover (no second executor)', async () => {
        const alive = new Set([25691]);
        const claude = { pid: 25700, ppid: 25691, start: 'Mon Nov  2 10:00:00 2026' };
        const { runtime, runScheduled } = makeRuntime(dir, alive, 17092, {
            snapshot: () => [claude],
            reap: () => [],
            readLive: () => [claude],
        });
        writeFileSync(sessionLockPath(SESSION, dir), JSON.stringify({ pid: 25691, startedAt: 1, version: '0.2.93' }));
        const pending = acquireSessionLock(SESSION, { takeover: true, version: '0.2.95' }, runtime);
        alive.delete(25691);
        for (let i = 0; i < 40; i++) runScheduled();
        await expect(pending).resolves.toEqual({ ok: false, holder: { pid: 25691, startedAt: 1, version: '0.2.93' } });
        expect(readSessionLock(SESSION, dir)?.pid).toBe(25691);
    });

    it('B-864: two takeover claimants never both win — the second takes over from the first', async () => {
        // Two daemons (or a re-attach beside a restore) restart the same
        // session at once. Before the claim file both saw holder 25691, both
        // waited it out, both wrote the record and both connected.
        const alive = new Set([25691, 30001, 30002]);
        const a = makeRuntime(dir, alive, 30001);
        const b = makeRuntime(dir, alive, 30002);
        writeFileSync(sessionLockPath(SESSION, dir), JSON.stringify({ pid: 25691, startedAt: 1, version: '0.2.194' }));

        const first = acquireSessionLock(SESSION, { takeover: true, version: '0.2.195' }, a.runtime);
        const second = acquireSessionLock(SESSION, { takeover: true, version: '0.2.195' }, b.runtime);
        expect(a.signals).toEqual([{ pid: 25691, signal: 'SIGTERM' }]);
        expect(b.signals).toEqual([]);            // waits on the claim, does not signal the old holder too

        alive.delete(25691);
        a.runScheduled();                         // grace → holder gone
        a.runScheduled();                         // settle
        await expect(first).resolves.toEqual({ ok: true, replaced: { pid: 25691, startedAt: 1, version: '0.2.194' } });
        expect(readSessionLock(SESSION, dir)?.pid).toBe(30001);

        b.runScheduled();                         // claim poll → free now; holder is the first claimant
        expect(b.signals).toEqual([{ pid: 30001, signal: 'SIGTERM' }]);
        expect(readSessionLock(SESSION, dir)?.pid).toBe(30001);
        alive.delete(30001);
        b.runScheduled();
        b.runScheduled();
        await expect(second).resolves.toMatchObject({ ok: true, replaced: { pid: 30001 } });
        expect(readSessionLock(SESSION, dir)?.pid).toBe(30002);
        expect(existsSync(`${sessionLockPath(SESSION, dir)}.claim`)).toBe(false);
    });

    it('B-864: a claimant that waits past the claim window yields instead of joining in', async () => {
        let now = 1_700_000_000_000;
        const alive = new Set([30001]);
        const b = makeRuntime(dir, alive, 30002);
        b.runtime.now = () => now;
        writeFileSync(`${sessionLockPath(SESSION, dir)}.claim`, '30001');
        const pending = acquireSessionLock(SESSION, { takeover: true, version: '0.2.195', claimWaitMs: 1_000 }, b.runtime);
        now += 1_000;
        b.runScheduled();
        await expect(pending).resolves.toEqual({ ok: false, holder: { pid: 30001, startedAt: 0, version: '' } });
        expect(b.signals).toEqual([]);
        expect(readFileSync(`${sessionLockPath(SESSION, dir)}.claim`, 'utf-8')).toBe('30001');
    });

    it('B-864: a claim left by a dead claimant is cleared', async () => {
        const { runtime } = makeRuntime(dir, new Set());
        writeFileSync(`${sessionLockPath(SESSION, dir)}.claim`, '44444');
        await expect(acquireSessionLock(SESSION, { takeover: true, version: '0.2.195' }, runtime)).resolves.toEqual({ ok: true, replaced: null });
        expect(readSessionLock(SESSION, dir)?.pid).toBe(17092);
        expect(existsSync(`${sessionLockPath(SESSION, dir)}.claim`)).toBe(false);
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
