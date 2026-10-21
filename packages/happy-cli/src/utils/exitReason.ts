import { logger } from '@/ui/logger';

/**
 * B-689: a wrapper the daemon spawns has `stdio: 'ignore'`, so whatever main()
 * prints to the console before `process.exit(1)` is lost — the 10-21 worker
 * exited 1 with nothing in its log. Every non-zero exit now leaves one
 * `[EXIT] …` line in the session log file; the daemon reads it back
 * (startupExit.ts) to say why a spawn failed.
 */
let recorded = false;

export function recordExitReason(code: number, reason: string): void {
    recorded = true;
    logger.debug(`[EXIT] Exiting with code ${code}: ${oneLine(reason)}`);
}

export function installExitReasonFallback(): void {
    process.on('exit', (code) => {
        if (code !== 0 && !recorded) logger.debug(`[EXIT] Exiting with code ${code}: no reason was recorded`);
    });
}

export function errorReason(error: unknown): string {
    return error instanceof Error ? error.message : String(error ?? 'Unknown error');
}

function oneLine(value: string): string {
    const line = value.replace(/\s+/g, ' ').trim();
    return line.length > 500 ? `${line.slice(0, 499)}…` : line;
}
