/**
 * B-850a daemon-only glue (never imported by a wrapper: node-pty stays out of
 * the wrapper's import graph, see daemon/machineMetadata.ts).
 */
import { unwatchFile, watchFile } from 'node:fs';
import * as pty from 'node-pty';
import type { PtyLike } from './setupTokenLogin';
import { accountsPath } from './store';
import { providersPath } from '@/claude/providerBinding';

export { SPAWN_ACCOUNT_ENV } from './store';

/** `claude setup-token` in a wide pty: its Ink UI renders only on a TTY, and 1000 columns keep the URL on one line. */
export function spawnSetupTokenPty(cwd: string, env: Record<string, string>): PtyLike {
    return pty.spawn('claude', ['setup-token'], { name: 'xterm-256color', cols: 1000, rows: 50, cwd, env });
}

export const ACCOUNT_WATCH_INTERVAL_MS = 5_000;
/** Expiry is time-driven: republish so 「即将过期 / 已过期」 move without an edit. */
export const ACCOUNT_REPUBLISH_INTERVAL_MS = 60 * 60_000;

/** Republish on edits made outside the daemon (`very-happy account …`, a hand edit). */
export function watchAccountFiles(home: string, onChange: () => void): () => void {
    const paths = [accountsPath(home), providersPath(home)];
    const listener = (curr: { mtimeMs: number }, prev: { mtimeMs: number }) => {
        if (curr.mtimeMs !== prev.mtimeMs) onChange();
    };
    for (const path of paths) watchFile(path, { interval: ACCOUNT_WATCH_INTERVAL_MS, persistent: false }, listener);
    const timer = setInterval(onChange, ACCOUNT_REPUBLISH_INTERVAL_MS);
    timer.unref?.();
    return () => {
        for (const path of paths) unwatchFile(path, listener);
        clearInterval(timer);
    };
}
