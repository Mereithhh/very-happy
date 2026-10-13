/**
 * B-587 — the wrapper side of idle hibernation: periodically ask the local
 * daemon whether this session may hibernate, and on "yes" run the commit
 * protocol (spec §3). Runner-agnostic: Claude and Codex inject their own
 * state getters and their own "go offline and exit" step.
 */
import { logger } from '@/ui/logger';
import {
    evaluateWrapperIdle,
    HIBERNATION_UNSUPPORTED_BACKOFF_MS,
    type HibernationStamp,
    type HibernationVerdict,
    type WrapperIdleSnapshot,
} from './hibernationPolicy';

export interface HibernateCheckAnswer {
    hibernate: boolean;
    reason?: string;
    idleMs?: number;
    nextCheckMs?: number;
}

/** `unsupported` = old daemon (404) / no daemon; `error` = transient. */
export type HibernateCheckResult = HibernateCheckAnswer | 'unsupported' | 'error';

export interface HibernationCommitClient {
    beginHibernationCommit(): void;
    inboundRoutedSinceCommit(): boolean;
    freezeInbound(): void;
    flush(): Promise<void>;
    readonly messageCursor: number;
}

export interface HibernationCommitDeps {
    client: HibernationCommitClient;
    /** Claim the session exit for 'hibernate'; false when cleanup already runs for another reason. */
    claimExit: () => boolean;
    /** Undo the claim after an abort (the session keeps running). */
    releaseExit: () => void;
    /** Re-evaluate the wrapper-owned rules right now. */
    recheck: () => HibernationVerdict;
    idleMs: number;
    /** Stamp metadata, go offline (deactivate — never archive) and exit. */
    finish: (stamp: HibernationStamp) => Promise<void>;
    now?: () => number;
    log?: (message: string) => void;
}

/**
 * Spec §3: claim → watch inbound → flush → re-check → freeze → stamp → offline.
 * Returns false (and leaves the session running) when anything moved.
 */
export async function commitHibernation(deps: HibernationCommitDeps): Promise<boolean> {
    const log = deps.log ?? ((message: string) => logger.debug(message));
    if (!deps.claimExit()) {
        log('[hibernate] exit already claimed for another reason; not hibernating');
        return false;
    }
    deps.client.beginHibernationCommit();
    try {
        await deps.client.flush();
    } catch (error) {
        log(`[hibernate] flush failed, staying awake: ${error instanceof Error ? error.message : String(error)}`);
        deps.releaseExit();
        return false;
    }
    const verdict = deps.recheck();
    if (deps.client.inboundRoutedSinceCommit() || !verdict.ok) {
        log(`[hibernate] aborted at commit: ${deps.client.inboundRoutedSinceCommit() ? 'inbound message' : (verdict as { reason: string }).reason}`);
        deps.releaseExit();
        return false;
    }
    deps.client.freezeInbound();
    const stamp: HibernationStamp = { at: (deps.now ?? Date.now)(), seq: deps.client.messageCursor, idleMs: deps.idleMs, v: 1 };
    log(`[hibernate] committing: seq=${stamp.seq} idleMs=${stamp.idleMs}`);
    await deps.finish(stamp);
    return true;
}

export interface HibernationProbeDeps {
    checkMs: number;
    snapshot: () => WrapperIdleSnapshot;
    ask: (snapshot: WrapperIdleSnapshot) => Promise<HibernateCheckResult>;
    /** Run the commit protocol with the daemon-confirmed threshold. */
    commit: (idleMs: number) => Promise<boolean>;
    now?: () => number;
    setTimer?: (fn: () => void, ms: number) => unknown;
    clearTimer?: (handle: unknown) => void;
    log?: (message: string) => void;
}

/**
 * Timer loop. Only asks when every non-time rule already holds locally
 * (`idleMs = 1` probe), so a busy session never even POSTs.
 */
export class HibernationProbe {
    private timer: unknown = null;
    private stopped = false;
    private running = false;

    constructor(private readonly deps: HibernationProbeDeps) {}

    start(): void {
        this.schedule(this.deps.checkMs);
    }

    stop(): void {
        this.stopped = true;
        if (this.timer !== null) (this.deps.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout)))(this.timer);
        this.timer = null;
    }

    private schedule(ms: number): void {
        if (this.stopped) return;
        const set = this.deps.setTimer ?? ((fn, delay) => {
            const handle = setTimeout(fn, delay);
            handle.unref?.();
            return handle;
        });
        this.timer = set(() => { void this.tick(); }, Math.max(1000, ms));
    }

    /** One sample; returns the delay it scheduled (or null when it hibernated / stopped). */
    async tick(): Promise<number | null> {
        if (this.stopped || this.running) return null;
        this.running = true;
        const log = this.deps.log ?? ((message: string) => logger.debug(message));
        try {
            const now = (this.deps.now ?? Date.now)();
            const snapshot = this.deps.snapshot();
            const local = evaluateWrapperIdle(snapshot, 1, now);
            if (!local.ok) {
                this.schedule(this.deps.checkMs);
                return this.deps.checkMs;
            }
            const answer = await this.deps.ask(snapshot);
            if (answer === 'unsupported') {
                this.schedule(HIBERNATION_UNSUPPORTED_BACKOFF_MS);
                return HIBERNATION_UNSUPPORTED_BACKOFF_MS;
            }
            if (answer === 'error') {
                this.schedule(this.deps.checkMs);
                return this.deps.checkMs;
            }
            if (answer.hibernate && typeof answer.idleMs === 'number' && answer.idleMs > 0) {
                const done = await this.deps.commit(answer.idleMs);
                if (done) {
                    this.stopped = true;
                    return null;
                }
                this.schedule(this.deps.checkMs);
                return this.deps.checkMs;
            }
            const next = typeof answer.nextCheckMs === 'number' && answer.nextCheckMs > 0 ? answer.nextCheckMs : this.deps.checkMs;
            if (answer.reason) log(`[hibernate] daemon says stay awake (${answer.reason}); next check in ${Math.round(next / 1000)}s`);
            this.schedule(next);
            return next;
        } catch (error) {
            log(`[hibernate] probe failed: ${error instanceof Error ? error.message : String(error)}`);
            this.schedule(this.deps.checkMs);
            return this.deps.checkMs;
        } finally {
            this.running = false;
        }
    }
}
