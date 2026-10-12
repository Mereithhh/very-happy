/**
 * B-550 review: the final scrollback checkpoint must run INSIDE the shutdown
 * sequence without endangering it — started first (overlapping the
 * daemon-state update + 100ms wait), awaited before teardown, and bounded far
 * below requestShutdown's 1s forced exit so cleanupDaemonState /
 * releaseDaemonLock / stopCaffeinate still run. Source wiring (the behaviour
 * of the bounded flush itself is in terminal/scrollbackCheckpoint.test.ts).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SHUTDOWN_FLUSH_BUDGET_MS } from '@/terminal/scrollbackCheckpoint';

const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const run = stripComments(readFileSync(fileURLToPath(new URL('./run.ts', import.meta.url)), 'utf8'));
const machine = stripComments(readFileSync(fileURLToPath(new URL('../api/apiMachine.ts', import.meta.url)), 'utf8'));

describe('shutdown scrollback flush wiring (B-550)', () => {
    const body = run.slice(run.indexOf('const cleanupAndShutdown = async'));

    it('starts the flush first and awaits it before any teardown', () => {
        const start = body.indexOf('const scrollbackFlush = apiMachine.flushTerminalScrollback();');
        const stateUpdate = body.indexOf("status: 'shutting-down'");
        const awaited = body.indexOf('await scrollbackFlush;');
        const mirror = body.indexOf('await mirrorManager.shutdown()');
        const cleanup = body.indexOf('await cleanupDaemonState();');
        const lock = body.indexOf('await releaseDaemonLock(daemonLockHandle);');
        expect(start).toBeGreaterThan(-1);
        expect(start).toBeLessThan(stateUpdate);
        expect(awaited).toBeGreaterThan(stateUpdate);
        expect(awaited).toBeLessThan(mirror);
        expect(mirror).toBeLessThan(cleanup);
        expect(cleanup).toBeLessThan(lock);
    });

    it('cannot reject into the cleanup and stays well inside the 1s forced exit', () => {
        expect(machine).toMatch(/flushTerminalScrollback\(\): Promise<void> \{\s*return this\.webTerminal\.flushScrollbackForShutdown\(\)\.catch\(\(\) => undefined\);/);
        expect(run).toContain('}, 1_000);');
        expect(SHUTDOWN_FLUSH_BUDGET_MS).toBeLessThanOrEqual(400);
    });
});
