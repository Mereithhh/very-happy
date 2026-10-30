/**
 * B-587 — the wrapper side of idle hibernation: periodically ask the local
 * daemon whether this session may hibernate, and on "yes" run the commit
 * protocol (spec §3). Runner-agnostic: Claude and Codex inject their own
 * state getters and their own "go offline and exit" step.
 */
import { logger } from '@/ui/logger';
import type { Metadata } from '@/api/types';
import {
    evaluateWrapperIdle,
    isQuiescent,
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
    /** The daemon's keep-awake latch for this session (survives an old web stripping the field). */
    keepAwake?: boolean;
}

/** `unsupported` = old daemon (404) / no daemon; `error` = transient. */
export type HibernateCheckResult = HibernateCheckAnswer | 'unsupported' | 'error';

export interface HibernationCommitClient {
    beginHibernationCommit(): void;
    inboundRoutedSinceCommit(): boolean;
    freezeInbound(): void;
    unfreezeInbound(): void;
    flush(): Promise<void>;
    updateMetadataAndWait(handler: (metadata: Metadata) => Metadata, timeoutMs?: number): Promise<boolean>;
    updateMetadata(handler: (metadata: Metadata) => Metadata): void;
    readonly messageCursor: number;
    muteHeartbeats(): void;
    unmuteHeartbeats(): void;
    readonly lastHeartbeatAt: number;
}

/**
 * The server batches heartbeats and flushes them every 5 s as `active: true`;
 * an old server can flush a beat queued just before our offline write AFTER
 * it (fixed server-side in B-587, kept here for old servers): stop beating and
 * let one batch window pass before going offline.
 */
export const PRESENCE_SETTLE_MS = 6_000;

export interface HibernationCommitDeps {
    client: HibernationCommitClient;
    /** Claim the session exit for 'hibernate'; false when cleanup already runs for another reason. */
    claimExit: () => boolean;
    /** A user archive / kill or a signal arrived meanwhile (deferred by the gate). */
    exitRequested: () => boolean;
    /** Past the last check: later exit requests no longer abort. */
    markCommitted: () => void;
    /** Hand the exit back after an abort; the runner runs any deferred exit now. */
    releaseExit: () => void;
    /** Re-evaluate the wrapper-owned rules right now. */
    recheck: () => HibernationVerdict;
    idleMs: number;
    /** Go offline (deactivate — never archive) and exit. The stamp is already written. */
    finish: (stamp: HibernationStamp) => Promise<void>;
    presenceSettleMs?: number;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
    log?: (message: string) => void;
}

/**
 * Spec §3: claim → watch inbound → flush → check → freeze (hold inbound) →
 * write the stamp and WAIT for it → check again → commit → offline.
 * Any failure or movement aborts: held inbound is routed, the stamp (if it
 * landed) is cleared, the exit is handed back (and a deferred archive / kill /
 * SIGTERM runs at once). Returns true only when the session went offline.
 */
export async function commitHibernation(deps: HibernationCommitDeps): Promise<boolean> {
    const log = deps.log ?? ((message: string) => logger.debug(message));
    if (!deps.claimExit()) {
        log('[hibernate] exit already claimed for another reason; not hibernating');
        return false;
    }
    const { client } = deps;
    const now = deps.now ?? Date.now;
    const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    let frozen = false;
    let stamped = false;
    /**
     * Review P3-3: every wait in the commit window ends early when an exit is
     * requested (a stop-session SIGTERM is followed by SIGKILL after 2 s), so
     * the deferred exit runs promptly instead of after the full wait.
     */
    const waitOrExit = async <T>(work: Promise<T>, fallback: T): Promise<T> => {
        let settled = false;
        const watched = work.finally(() => { settled = true; });
        const exitWatch = (async (): Promise<T> => {
            while (!settled && !deps.exitRequested()) await sleep(EXIT_POLL_MS);
            return settled ? watched : fallback;
        })();
        return Promise.race([watched, exitWatch]);
    };
    const abort = async (why: string): Promise<false> => {
        log(`[hibernate] aborted at commit: ${why}`);
        if (stamped) {
            // Review P3-2: clear the stamp and WAIT for it (bounded; shorter when
            // an exit is waiting) — a leftover stamp would show a running
            // session as hibernated once it goes offline.
            const clear = (metadata: Metadata) => { const next = { ...metadata }; delete next.hibernation; return next; };
            const cleared = await client.updateMetadataAndWait(clear, deps.exitRequested() ? EXIT_CLEAR_TIMEOUT_MS : undefined).catch(() => false);
            if (!cleared) log('[hibernate] stamp clear not confirmed (it keeps retrying in the background)');
        }
        if (frozen) { client.unmuteHeartbeats(); client.unfreezeInbound(); }
        deps.releaseExit();
        return false;
    };
    const moved = (): string | null => {
        if (deps.exitRequested()) return 'exit requested';
        if (client.inboundRoutedSinceCommit()) return 'inbound message';
        const verdict = deps.recheck();
        return verdict.ok ? null : verdict.reason;
    };
    client.beginHibernationCommit();
    try {
        await client.flush();
    } catch (error) {
        return abort(`flush failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    let why = moved();
    if (why) return abort(why);
    client.freezeInbound();
    client.muteHeartbeats();
    frozen = true;
    const stamp: HibernationStamp = { at: now(), seq: client.messageCursor, idleMs: deps.idleMs, v: 1 };
    // A timed-out / interrupted write may still land later; clear it on abort either way.
    stamped = true;
    const landed = await waitOrExit(client.updateMetadataAndWait((metadata) => ({ ...metadata, hibernation: stamp })).catch(() => false), false);
    if (deps.exitRequested()) return abort('exit requested');
    if (!landed) return abort('stamp not confirmed');
    const settle = Math.max(0, client.lastHeartbeatAt + (deps.presenceSettleMs ?? PRESENCE_SETTLE_MS) - now());
    if (settle > 0) await waitOrExit(sleep(settle), undefined);
    why = moved();
    if (why) return abort(why);
    deps.markCommitted();
    log(`[hibernate] committing: seq=${stamp.seq} idleMs=${stamp.idleMs}`);
    await deps.finish(stamp);
    return true;
}

/** How often a commit-window wait checks for a requested exit. */
export const EXIT_POLL_MS = 100;
/** Bounded stamp clear when an exit is waiting behind the abort. */
export const EXIT_CLEAR_TIMEOUT_MS = 1_000;

export interface HibernationProbeDeps {
    checkMs: number;
    snapshot: () => WrapperIdleSnapshot;
    ask: (snapshot: WrapperIdleSnapshot) => Promise<HibernateCheckResult>;
    /** Run the commit protocol with the daemon-confirmed threshold. */
    commit: (idleMs: number) => Promise<boolean>;
    /** The daemon holds a keep-awake latch for this session (heal the stripped field). */
    onKeepAwakeLatched?: () => void;
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
            // keep-awake is still REPORTED (the daemon latches it, review P2-4);
            // so is any quiescent session (B-852: the daemon may restart a stale
            // wrapper — teams, automation and pi included); every other local
            // refusal never bothers the daemon.
            if (!local.ok && local.reason !== 'keep-awake' && !isQuiescent(snapshot)) {
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
            if (answer.keepAwake === true) this.deps.onKeepAwakeLatched?.();
            if (local.ok && answer.hibernate && typeof answer.idleMs === 'number' && answer.idleMs > 0) {
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

/**
 * Review P1-1 for runners without a SessionExitGate (Codex): while a
 * hibernation is deciding, an archive / kill / signal is DEFERRED (archive
 * outranks offline) instead of ignored; an aborted hibernation hands it back
 * via `release()`. Once committed the process is leaving offline anyway.
 */
export class HibernationExitLatch<I extends string> {
    private active = false;
    private committed = false;
    private deferredIntent: I | null = null;

    constructor(private readonly outranks: (a: I, b: I) => boolean) {}

    begin(): boolean {
        if (this.active) return false;
        this.active = true;
        this.committed = false;
        this.deferredIntent = null;
        return true;
    }

    get hibernating(): boolean {
        return this.active;
    }

    /** true = the caller must NOT run this exit now (deferred, or the process is already leaving). */
    intercept(intent: I): boolean {
        if (!this.active) return false;
        if (!this.committed && (this.deferredIntent === null || this.outranks(intent, this.deferredIntent))) this.deferredIntent = intent;
        return true;
    }

    get exitRequested(): boolean {
        return this.deferredIntent !== null;
    }

    commit(): void {
        if (this.active) this.committed = true;
    }

    /** Abort: returns the deferred exit to run now (or null). No-op once committed. */
    release(): I | null {
        if (!this.active || this.committed) return null;
        this.active = false;
        const deferred = this.deferredIntent;
        this.deferredIntent = null;
        return deferred;
    }
}
