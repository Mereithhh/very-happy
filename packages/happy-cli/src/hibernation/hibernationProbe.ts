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
    let frozen = false;
    let stamped = false;
    const abort = (why: string): false => {
        log(`[hibernate] aborted at commit: ${why}`);
        if (stamped) client.updateMetadata((metadata) => { const next = { ...metadata }; delete next.hibernation; return next; });
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
    const stamp: HibernationStamp = { at: (deps.now ?? Date.now)(), seq: client.messageCursor, idleMs: deps.idleMs, v: 1 };
    let landed = false;
    try {
        landed = await client.updateMetadataAndWait((metadata) => ({ ...metadata, hibernation: stamp }));
    } catch {
        landed = false;
    }
    // A timed-out write may still land later; clear it on abort either way.
    stamped = true;
    if (!landed) return abort('stamp not confirmed');
    why = deps.exitRequested() ? 'exit requested' : null;
    if (why) return abort(why);
    const now = deps.now ?? Date.now;
    const settle = Math.max(0, client.lastHeartbeatAt + (deps.presenceSettleMs ?? PRESENCE_SETTLE_MS) - now());
    if (settle > 0) await (deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))))(settle);
    why = moved();
    if (why) return abort(why);
    deps.markCommitted();
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
            // every other local refusal never bothers the daemon.
            if (!local.ok && local.reason !== 'keep-awake') {
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
