import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { preparePrivateDebugLogFile } from './privateDebugLog';

describe.skipIf(process.platform === 'win32')('private remote-debug logs', () => {
    const roots: string[] = [];
    afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

    it('creates the .logs directory as 0700 and its log file as 0600', () => {
        const root = mkdtempSync(join(tmpdir(), 'very-happy-debug-log-'));
        roots.push(root);
        const logsDir = join(root, '.logs');
        const logFile = preparePrivateDebugLogFile(logsDir, 'remote.log');
        expect(statSync(logsDir).mode & 0o777).toBe(0o700);
        expect(statSync(logFile).mode & 0o777).toBe(0o600);
    });

    it('hardens an existing permissive directory and file', () => {
        const root = mkdtempSync(join(tmpdir(), 'very-happy-debug-log-old-'));
        roots.push(root);
        const logsDir = join(root, '.logs');
        const logFile = preparePrivateDebugLogFile(logsDir, 'remote.log');
        chmodSync(logsDir, 0o755);
        writeFileSync(logFile, 'historical remote log', { mode: 0o644 });
        chmodSync(logFile, 0o644);
        preparePrivateDebugLogFile(logsDir, 'remote.log');
        expect(statSync(logsDir).mode & 0o777).toBe(0o700);
        expect(statSync(logFile).mode & 0o777).toBe(0o600);
    });
});
