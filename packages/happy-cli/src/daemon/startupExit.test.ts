import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describeStartupExit, extractStartupExitReason, readStartupExitReason } from './startupExit';

// The 10-21 wrapper log (PID 2484333), trimmed: an old wrapper with no [EXIT] line.
const OLD_WRAPPER_LOG = `[14:56:05.165] Using machineId: 8800f02a
[14:56:05.467] [API] [ERROR] Failed to get or create session: {
  name: 'Error',
  message: 'Client network socket disconnected before secure TLS connection was established',
  code: 'ECONNRESET'
}
[14:56:12.456] Session created/loaded: cmvhrdm731b0fo92kerhwkwcz (tag: becd1882)
[14:56:13.484] [FILE_WATCHER] Watch error: ENOENT: no such file or directory, retrying in 2000ms
`;

let dir: string | undefined;
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined; });

describe('B-689 startup exit reason', () => {
    it('prefers the wrapper’s own [EXIT] line', () => {
        const log = `${OLD_WRAPPER_LOG}[14:56:14.600] [EXIT] Exiting with code 1: Could not create the session on the server after 5 attempts: ECONNRESET - connection reset by server\n`;
        expect(extractStartupExitReason(log)).toBe('Could not create the session on the server after 5 attempts: ECONNRESET - connection reset by server');
    });
    it('falls back to the last logged error of an older wrapper', () => {
        expect(extractStartupExitReason(OLD_WRAPPER_LOG)).toBe('[API] [ERROR] Failed to get or create session: Client network socket disconnected before secure TLS connection was established ECONNRESET');
        expect(extractStartupExitReason('[1] nothing wrong\n')).toBeUndefined();
    });
    it('names the real exit instead of a webhook timeout', () => {
        expect(describeStartupExit({ exited: true, code: 1, signal: null, reason: 'boom' }, 15_000)).toBe('Agent process exited during startup (code 1): boom');
        expect(describeStartupExit({ exited: true, code: null, signal: 'SIGKILL' }, 15_000)).toBe('Agent process exited during startup (signal SIGKILL): no reason found in its log');
        expect(describeStartupExit({ exited: true, code: null, signal: null, timedOut: true }, 15_000)).toBe('Agent process did not report its session within 15s and was stopped');
        expect(describeStartupExit({ exited: false, code: null, signal: null, timedOut: true }, 15_000)).toBe('Agent process did not report its session within 15s and could not be confirmed stopped');
    });
    it('reads the newest session log of that PID, never a daemon log', () => {
        dir = mkdtempSync(join(tmpdir(), 'vh-startup-exit-'));
        writeFileSync(join(dir, '2026-10-21-14-56-04-pid-2484333.log'), '[x] [EXIT] Exiting with code 1: right one\n');
        writeFileSync(join(dir, '2026-10-20-10-00-00-pid-2484333.log'), '[x] [EXIT] Exiting with code 1: older\n');
        writeFileSync(join(dir, '2026-10-21-11-58-02-pid-24843333-daemon.log'), '[x] [EXIT] Exiting with code 1: daemon\n');
        expect(readStartupExitReason(dir, 2484333)).toBe('right one');
        expect(readStartupExitReason(dir, 1)).toBeUndefined();
        expect(readStartupExitReason(join(dir, 'missing'), 2484333)).toBeUndefined();
    });
});
