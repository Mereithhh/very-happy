import type { Session } from '@/api/types';
import { connectionState } from '@/utils/serverConnectionErrors';

/**
 * B-689: a daemon-spawned wrapper must never fall into the terminal's offline
 * mode. That mode runs the interactive Claude CLI locally — without a TTY it
 * exits at once — and creates the session on reconnection without ever
 * reporting it to the daemon (10-21: ECONNRESET on the first create → local
 * launcher → exit 1, the daemon waited 15 s for a webhook that never came).
 *
 * Daemon spawns retry the create briefly (the daemon waits 15 s in total) and
 * then fail with a stated reason; the daemon/teams layer owns longer retries.
 * Terminal starts keep the single attempt + offline mode.
 */
export const DAEMON_SESSION_CREATE_RETRY_DELAYS_MS = [500, 1_000, 2_000, 3_000] as const;

export class SessionStartupError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'SessionStartupError';
    }
}

export async function createSessionForStartup(
    create: () => Promise<Session | null>,
    opts: {
        startedBy?: 'daemon' | 'terminal';
        delaysMs?: readonly number[];
        sleep?: (ms: number) => Promise<void>;
        log?: (message: string) => void;
    },
): Promise<Session | null> {
    if (opts.startedBy !== 'daemon') return create();
    const delays = opts.delaysMs ?? DAEMON_SESSION_CREATE_RETRY_DELAYS_MS;
    const sleep = opts.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
    for (let attempt = 0; ; attempt++) {
        const session = await create();
        if (session) return session;
        if (attempt >= delays.length) break;
        opts.log?.(`[START] Session create attempt ${attempt + 1} failed (${connectionState.describe('Session creation') ?? 'server unavailable'}); retrying in ${delays[attempt]}ms`);
        await sleep(delays[attempt]);
    }
    throw new SessionStartupError(`Could not create the session on the server after ${delays.length + 1} attempts: ${connectionState.describe('Session creation') ?? 'server unavailable'}`);
}
