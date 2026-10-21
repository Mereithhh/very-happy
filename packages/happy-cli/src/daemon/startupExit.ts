import { closeSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * B-689: why a daemon-spawned wrapper died before it reported its session.
 *
 * The wrapper runs with `stdio: 'ignore'`, so the daemon cannot read its
 * stderr; the wrapper's own log file is the record (utils/exitReason.ts writes
 * an `[EXIT] …` line on every non-zero exit). Older wrappers have no `[EXIT]`
 * line — fall back to the last logged error.
 */
export type StartupExit = {
    /** The process is confirmed gone (exited, or stopped after the timeout). */
    exited: boolean;
    code: number | null;
    signal: string | null;
    /** No session report within the spawn window; the daemon stopped it. */
    timedOut?: boolean;
    reason?: string;
};

const TAIL_BYTES = 64 * 1024;
const MAX_REASON = 300;

export function extractStartupExitReason(logText: string): string | undefined {
    const lines = logText.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
        const exit = /\[EXIT\] Exiting with code -?\d+: (.+)$/.exec(lines[i]);
        if (exit) return clamp(exit[1]);
    }
    for (let i = lines.length - 1; i >= 0; i--) {
        if (!/\[ERROR\]|\[WARN\]/.test(lines[i])) continue;
        // Errors are logged as `… [ERROR] <what>: { message: '…', code: '…' }`.
        const detail = lines.slice(i, i + 8).join('\n');
        const message = /message: '([^'\n]+)'/.exec(detail)?.[1];
        const code = /code: '([A-Z0-9_]+)'/.exec(detail)?.[1];
        const head = lines[i].replace(/^\[[\d:.]+\]\s*/, '').replace(/\s*\{\s*$/, '').trim();
        return clamp([head, message, code].filter(Boolean).join(' '));
    }
    return undefined;
}

export function describeStartupExit(exit: StartupExit, timeoutMs: number): string {
    if (exit.timedOut) {
        const tail = exit.exited ? 'and was stopped' : 'and could not be confirmed stopped';
        return `Agent process did not report its session within ${Math.round(timeoutMs / 1000)}s ${tail}${exit.reason ? `: ${exit.reason}` : ''}`;
    }
    const how = exit.signal ? `signal ${exit.signal}` : `code ${exit.code ?? 'unknown'}`;
    return `Agent process exited during startup (${how}): ${exit.reason ?? 'no reason found in its log'}`;
}

/** Reads the newest `<timestamp>-pid-<pid>.log` (never a daemon log). Never throws. */
export function readStartupExitReason(logsDir: string, pid: number): string | undefined {
    try {
        const suffix = `-pid-${pid}.log`;
        const file = readdirSync(logsDir).filter(name => name.endsWith(suffix)).sort().pop();
        if (!file) return undefined;
        const path = join(logsDir, file);
        const size = statSync(path).size;
        const length = Math.min(size, TAIL_BYTES);
        const buffer = Buffer.alloc(length);
        const fd = openSync(path, 'r');
        try { readSync(fd, buffer, 0, length, size - length); } finally { closeSync(fd); }
        return extractStartupExitReason(buffer.toString('utf8'));
    } catch {
        return undefined;
    }
}

function clamp(value: string): string {
    const line = value.replace(/\s+/g, ' ').trim();
    return line.length > MAX_REASON ? `${line.slice(0, MAX_REASON - 1)}…` : line;
}
