import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const originalEnv = { ...process.env };

/**
 * B-864: when a second daemon had taken over (state + lock rewritten by it),
 * the first daemon's shutdown deleted the second one's files; the second then
 * saw "a different daemon" and shut down too — repro
 * `vh-team-B-864/home/logs/*-pid-50698{8}-daemon.log` → `*-pid-509043-daemon.log`.
 */
describe('daemon state / lock cleanup ownership', () => {
    let home: string;
    beforeEach(async () => {
        home = join(tmpdir(), `vh-daemon-own-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        await mkdir(home, { recursive: true });
        process.env = { ...originalEnv, HAPPY_HOME_DIR: home };
        vi.resetModules();
    });
    afterEach(async () => {
        process.env = { ...originalEnv };
        await rm(home, { recursive: true, force: true });
    });

    const write = async (statePid: number, lockPid: number) => {
        const { configuration } = await import('./configuration');
        await writeFile(configuration.daemonStateFile, JSON.stringify({ pid: statePid, httpPort: 1, startTime: 'x', startedWithCliVersion: '0' }));
        await writeFile(configuration.daemonLockFile, String(lockPid));
        return configuration;
    };

    it('a daemon cleaning up after itself leaves another daemon\'s state and lock alone', async () => {
        const configuration = await write(509043, 509043);
        const p = await import('./persistence');
        await p.clearDaemonState(506988);
        expect(existsSync(configuration.daemonStateFile)).toBe(true);
        expect(existsSync(configuration.daemonLockFile)).toBe(true);
    });

    it('removes its own files', async () => {
        const configuration = await write(506988, 506988);
        const p = await import('./persistence');
        await p.clearDaemonState(506988);
        expect(existsSync(configuration.daemonStateFile)).toBe(false);
        expect(existsSync(configuration.daemonLockFile)).toBe(false);
    });

    it('stale cleanup (no owner) still removes both', async () => {
        const configuration = await write(1, 1);
        const p = await import('./persistence');
        await p.clearDaemonState();
        expect(existsSync(configuration.daemonStateFile)).toBe(false);
        expect(existsSync(configuration.daemonLockFile)).toBe(false);
    });

    it('releaseDaemonLock does not unlink a lock another daemon holds now', async () => {
        const configuration = await write(509043, 509043);
        const p = await import('./persistence');
        await p.releaseDaemonLock({ close: async () => undefined } as never);
        expect(existsSync(configuration.daemonLockFile)).toBe(true);
        await writeFile(configuration.daemonLockFile, String(process.pid));
        await p.releaseDaemonLock({ close: async () => undefined } as never);
        expect(existsSync(configuration.daemonLockFile)).toBe(false);
    });

    it('the daemon passes its own pid on every self-cleanup and stops its heartbeat once superseded', async () => {
        const { readFileSync } = await import('node:fs');
        const run = readFileSync(join(__dirname, 'daemon', 'run.ts'), 'utf8').replace(/\/\/.*$/gm, '');
        expect(run).not.toContain('await cleanupDaemonState();');
        expect(run.match(/await cleanupDaemonState\(process\.pid\);/g)?.length).toBe(2);
        // B-876b: the check lives in daemonOwnership (onSuperseded requests the shutdown); the heartbeat returns on it.
        expect(run).toMatch(/requestShutdown\('exception', 'A different daemon was started without killing us\. We should kill ourselves\.'\);/);
        expect(run).toMatch(/if \(!daemonOwnership\.owns\(\)\) return;\s*const woke = wakeDetector\.beat\(\);/);
    });
});
