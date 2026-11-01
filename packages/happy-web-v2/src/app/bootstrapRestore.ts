import { SyncNotStartedError } from '@/sync/syncNotStarted';

/**
 * B-859: a restore that failed before sync started (e.g. libsodium not up yet)
 * left the stored credentials intact, so retry it instead of rendering the
 * signed-out tree and landing on /login. Anything else — or the last attempt —
 * is rethrown and keeps the old behaviour.
 */
export const RESTORE_RETRY_DELAYS_MS: readonly number[] = [300, 1000, 3000];

export async function restoreWithRetry(
    run: () => Promise<void>,
    opts: {
        delaysMs?: readonly number[];
        sleep?: (ms: number) => Promise<void>;
        isCancelled?: () => boolean;
    } = {},
): Promise<void> {
    const delays = opts.delaysMs ?? RESTORE_RETRY_DELAYS_MS;
    const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    for (let attempt = 0; ; attempt++) {
        try {
            return await run();
        } catch (e) {
            const delay = delays[attempt];
            if (!(e instanceof SyncNotStartedError) || delay === undefined || opts.isCancelled?.()) throw e;
            console.warn(`[bootstrap] restore attempt ${attempt + 1} failed before sync started, retrying in ${delay}ms`, e.reason);
            await sleep(delay);
            if (opts.isCancelled?.()) throw e;
        }
    }
}
