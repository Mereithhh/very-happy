import { chmodSync, closeSync, mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';

export const PRIVATE_DEBUG_DIRECTORY_MODE = 0o700;
export const PRIVATE_DEBUG_FILE_MODE = 0o600;

/** Create or harden the remote-debug sink before pino opens it. */
export function preparePrivateDebugLogFile(logsDir: string, fileName: string): string {
    mkdirSync(logsDir, { recursive: true, mode: PRIVATE_DEBUG_DIRECTORY_MODE });
    chmodSync(logsDir, PRIVATE_DEBUG_DIRECTORY_MODE);
    const logFile = join(logsDir, fileName);
    const descriptor = openSync(logFile, 'a', PRIVATE_DEBUG_FILE_MODE);
    closeSync(descriptor);
    chmodSync(logFile, PRIVATE_DEBUG_FILE_MODE);
    return logFile;
}
