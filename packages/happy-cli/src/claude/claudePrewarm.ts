/**
 * B-515 phase 1: Claude process prewarm for fresh daemon-spawned sessions.
 *
 * `claudeRemote` starts the existing `query()` with an EMPTY input iterable
 * before the first message arrives, so Claude Code's spawn + initialize
 * handshake overlaps the user typing. Phase 0 (Mac, 3-run medians): pushed→init
 * 1074 ms cold vs 34 ms after 5 s idle; pushed→first assistant 3339→2100 ms.
 * No `startup()`/WarmQuery: that fixes every option at startup and accepts the
 * prompt once; a plain `query()` keeps the ordinary streaming-input path.
 *
 * This module holds the pure / file-level parts (eligibility, the predicted
 * system-prompt cache, the per-machine concurrency slots, the SessionStart
 * hook gate, the adoption decision and the log lines) plus the lease object
 * `runClaude` hands to `claudeRemote`. The query plumbing lives in
 * claudeRemote.ts. See specs/2026-09-optimistic-session-and-claude-prewarm.md.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { claudeModeHash } from './claudeModeHash';
import { needsModelSwitch } from './claudeLiveModel';
import type { EnhancedMode } from './loop';
import type { MessageMeta } from '@/api/types';
import { mapToClaudeMode, type ClaudeSdkPermissionMode } from './utils/permissionMode';

/** A warm process nobody used for this long is closed (spec: 15 min). */
export const CLAUDE_PREWARM_IDLE_MS = 15 * 60 * 1000;
/** At most this many warm (not yet adopted) Claude processes per machine. */
export const CLAUDE_PREWARM_MAX_CONCURRENT = 2;
/** Bound on the adoption-time liveness probe / permission switch. */
export const CLAUDE_PREWARM_ADOPT_TIMEOUT_MS = 5000;
/** `?source=` value prefix the warm process's SessionStart hook reports with. */
export const PREWARM_HOOK_SOURCE_PREFIX = 'prewarm-';

// ---------------------------------------------------------------------------
// Eligibility

/** `HAPPY_CLAUDE_AUTH_STATUS` values (daemon `claudeAuth.status`) that rule a prewarm out. */
const BAD_AUTH_STATUSES: ReadonlySet<string> = new Set(['not-logged-in', 'error', 'claude-missing']);
/** Claude args that make the first Query resume/continue something (never "fresh"). */
const RESUME_ARGS: ReadonlySet<string> = new Set(['--resume', '-r', '--continue', '-c', '--fork-session', '--session-id']);
/** This many consecutive first-message mispredictions on this machine switch the prewarm off until a would-be hit. */
export const CLAUDE_PREWARM_MAX_CONSECUTIVE_MISSES = 5;

export type ClaudePrewarmSessionInput = {
    env: Record<string, string | undefined>;
    startedBy?: string;
    startingMode?: string;
    claudeArgs?: string[];
    /** Raw `claudePrewarm` from ~/.happy/settings.json (no schema default — AGENTS constraint 1). */
    setting: unknown;
};

export type ClaudePrewarmEligibilityInput = ClaudePrewarmSessionInput & {
    /** The machine's prediction cache, or null. */
    cache: PrewarmCache | null;
};

export type ClaudePrewarmEligibility = { eligible: true } | { eligible: false; reason: string };

/**
 * Is THIS session the kind a prewarm is for? Only a FRESH Claude remote
 * session a daemon spawned for the web: no resume/fork/import/reconnect, not
 * the assistant singleton, not a teams/automation/assistant-dispatched session
 * or a `very-happy spawn --prompt` (their first message is not a web message,
 * so the prediction would miss), Claude auth not known-broken. Also decides
 * whether this session's first message may update the prediction cache.
 */
export function claudePrewarmSessionEligibility(input: ClaudePrewarmSessionInput): ClaudePrewarmEligibility {
    const { env } = input;
    const no = (reason: string): ClaudePrewarmEligibility => ({ eligible: false, reason });
    if (env.HAPPY_CLAUDE_PREWARM === '0') return no('env-off');
    if (input.setting === 'off') return no('setting-off');
    if (input.startedBy !== 'daemon') return no('not-daemon');
    if (input.startingMode !== 'remote') return no('not-remote');
    if (env.HAPPY_RECONNECT_SESSION_ID) return no('reconnect');
    if (env.HAPPY_FORK_CLAUDE_SESSION_ID || env.HAPPY_FORKED_FROM_SESSION_ID) return no('fork');
    if (env.HAPPY_IMPORTED_FROM_CLAUDE_SESSION_ID) return no('import');
    if (env.HAPPY_SESSION_VARIANT === 'assistant') return no('assistant');
    if (env.VH_TEAM_OPERATION_ID) return no('teams');
    if (env.VH_AUTOMATION_RUN_ID) return no('automation');
    if (env.HAPPY_SPAWNED_BY) return no('spawned-by');
    if (env.HAPPY_FIRST_MESSAGE_FROM_CLI === '1') return no('cli-first-message');
    if (input.claudeArgs?.some((arg) => RESUME_ARGS.has(arg))) return no('resume-args');
    if (env.HAPPY_CLAUDE_AUTH_STATUS && BAD_AUTH_STATUSES.has(env.HAPPY_CLAUDE_AUTH_STATUS)) return no('claude-auth');
    return { eligible: true };
}

/** Session eligibility + a usable prediction (cached web prompt, not auto-disabled by misses). */
export function claudePrewarmEligibility(input: ClaudePrewarmEligibilityInput): ClaudePrewarmEligibility {
    const session = claudePrewarmSessionEligibility(input);
    if (!session.eligible) return session;
    if (!input.cache?.appendSystemPrompt) return { eligible: false, reason: 'no-cached-system-prompt' };
    if (input.cache.consecutiveMisses >= CLAUDE_PREWARM_MAX_CONSECUTIVE_MISSES) return { eligible: false, reason: 'recent-misses' };
    return { eligible: true };
}

// ---------------------------------------------------------------------------
// Prediction cache (~/.happy/claude-prewarm.json): what the last web first
// message of an eligible session carried, and how often the prediction missed.

export type PrewarmCache = {
    appendSystemPrompt: string;
    /** The web's `effort` meta (agent default override); absent = the web did not send one. */
    effort?: string | null;
    consecutiveMisses: number;
};

export function prewarmCacheFile(happyHomeDir: string): string {
    return join(happyHomeDir, 'claude-prewarm.json');
}

export function readPrewarmCache(file: string): PrewarmCache | null {
    try {
        const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
        if (typeof raw?.appendSystemPrompt !== 'string' || raw.appendSystemPrompt.length === 0) return null;
        const misses = typeof raw.consecutiveMisses === 'number' && Number.isFinite(raw.consecutiveMisses) && raw.consecutiveMisses > 0
            ? Math.floor(raw.consecutiveMisses) : 0;
        return {
            appendSystemPrompt: raw.appendSystemPrompt,
            ...(typeof raw.effort === 'string' || raw.effort === null ? { effort: raw.effort as string | null } : {}),
            consecutiveMisses: misses,
        };
    } catch {
        return null;
    }
}

/** Atomic (tmp + rename), private. Best-effort: never throws. */
export function writePrewarmCache(file: string, cache: PrewarmCache): boolean {
    try {
        const tmp = `${file}.${process.pid}.tmp`;
        writeFileSync(tmp, JSON.stringify({ ...cache, updatedAt: Date.now() }), { mode: 0o600 });
        renameSync(tmp, file);
        return true;
    } catch {
        return false;
    }
}

/** The meta the prediction assumes the web's first message will carry. */
export function prewarmPredictionMeta(cache: PrewarmCache): MessageMeta {
    return {
        appendSystemPrompt: cache.appendSystemPrompt,
        ...(cache.effort !== undefined ? { effort: cache.effort } : {}),
    };
}

/**
 * The first web message of an eligible session arrived: was the prediction
 * right (by the adoption rule — the relaunch hash), and what to cache next.
 * `predicted` is null when there was no cache to predict with.
 */
export function evaluatePrewarmPrediction(input: {
    predicted: EnhancedMode | null;
    actual: EnhancedMode;
    meta: MessageMeta | undefined;
    previous: PrewarmCache | null;
}): { outcome: 'hit' | 'miss' | 'no-prediction'; next: PrewarmCache | null } {
    const outcome = input.predicted === null ? 'no-prediction'
        : claudeModeHash(input.predicted) === claudeModeHash(input.actual) ? 'hit' : 'miss';
    const append = input.meta?.appendSystemPrompt;
    const misses = outcome === 'miss' ? (input.previous?.consecutiveMisses ?? 0) + 1 : 0;
    if (typeof append !== 'string' || append.length === 0) {
        // Nothing to predict the next session with; keep the old cache but still count the miss.
        return { outcome, next: input.previous ? { ...input.previous, consecutiveMisses: misses } : null };
    }
    const hasEffort = !!input.meta && Object.prototype.hasOwnProperty.call(input.meta, 'effort');
    return {
        outcome,
        next: {
            appendSystemPrompt: append,
            ...(hasEffort ? { effort: (input.meta as { effort?: string | null }).effort ?? null } : {}),
            consecutiveMisses: misses,
        },
    };
}

// ---------------------------------------------------------------------------
// Per-machine concurrency: slot files under HAPPY_HOME_DIR/tmp/claude-prewarm
//
// Why files and not a daemon counter: a slot is claimed with O_EXCL, which is
// atomic across the wrappers of one machine without any daemon round trip or
// protocol change, works with an old daemon, and survives a daemon restart
// (wrappers outlive it — AGENTS constraint 7). A slot whose owner pid is gone,
// or that is older than the idle limit (pid reuse), is reclaimed. The one race
// left — two wrappers reclaiming the same stale slot at once — can at worst
// admit one extra warm process until it is adopted/discarded.

export type PrewarmSlot = { readonly path: string; release(): void };

export function prewarmSlotDir(happyHomeDir: string): string {
    return join(happyHomeDir, 'tmp', 'claude-prewarm');
}

export function acquirePrewarmSlot(dir: string, opts: {
    max?: number;
    pid?: number;
    isAlive?: (pid: number) => boolean;
    now?: number;
    staleMs?: number;
} = {}): PrewarmSlot | null {
    const max = opts.max ?? CLAUDE_PREWARM_MAX_CONCURRENT;
    const pid = opts.pid ?? process.pid;
    const isAlive = opts.isAlive ?? pidAlive;
    const now = opts.now ?? Date.now();
    const staleMs = opts.staleMs ?? CLAUDE_PREWARM_IDLE_MS + 60_000;
    try { mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch { return null; }
    for (let i = 0; i < max; i++) {
        const path = join(dir, `slot-${i}.lock`);
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                writeFileSync(path, String(pid), { flag: 'wx', mode: 0o600 });
                let released = false;
                return {
                    path,
                    release: () => {
                        if (released) return;
                        released = true;
                        try {
                            if (readFileSync(path, 'utf8').trim() === String(pid)) unlinkSync(path);
                        } catch { /* already gone */ }
                    },
                };
            } catch (error) {
                if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') return null;
                if (!slotIsStale(path, { isAlive, now, staleMs }) || attempt > 0) break;
                try { unlinkSync(path); } catch { /* someone else reclaimed it */ }
            }
        }
    }
    return null;
}

function slotIsStale(path: string, opts: { isAlive: (pid: number) => boolean; now: number; staleMs: number }): boolean {
    try {
        const owner = Number(readFileSync(path, 'utf8').trim());
        if (!Number.isInteger(owner) || owner <= 0 || !opts.isAlive(owner)) return true;
        return opts.now - statSync(path).mtimeMs > opts.staleMs;
    } catch {
        return !existsSync(path);
    }
}

function pidAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException)?.code === 'EPERM';
    }
}

// ---------------------------------------------------------------------------
// SessionStart hook gate
//
// The warm process gets its own hook settings file whose forwarder reports
// `?source=prewarm-<n>`. Its SessionStart fires during startup — long before
// anyone knows whether it will be used — so ids it reports are ignored until
// the process is adopted (and forever if it is discarded). After adoption the
// id is published through the system/init path like a cold start.

export class PrewarmHookGate {
    private next = 0;
    private readonly adopted = new Set<string>();

    newTag(): string {
        return `${PREWARM_HOOK_SOURCE_PREFIX}${process.pid}-${this.next++}`;
    }

    adopt(tag: string): void {
        this.adopted.add(tag);
    }

    /** Untagged hooks (the ordinary per-process settings file) always pass. */
    accepts(source: string | null | undefined): boolean {
        if (!source || !source.startsWith(PREWARM_HOOK_SOURCE_PREFIX)) return true;
        return this.adopted.has(source);
    }
}

// ---------------------------------------------------------------------------
// Adoption decision

export type WarmAdoptionDecision =
    | {
        adopt: true;
        /** SDK permission mode to set BEFORE the prompt is pushed (differs from the warm process's). */
        setPermissionMode?: ClaudeSdkPermissionMode;
        /** The first message moves the model: `setModel` before the prompt. */
        switchModel: boolean;
    }
    | { adopt: false; reason: 'mode-mismatch' | 'clear' | 'compact' };

/**
 * Can the first message run in the warm process? Only if everything `query()`
 * fixed at creation is identical — the relaunch hash, computed over modes that
 * both came out of `resolveMessageMode` — and the two live-movable fields are
 * moved into place first: the permission mode (exact SDK value) and the model.
 */
export function decideWarmAdoption(input: {
    predicted: EnhancedMode;
    actual: EnhancedMode;
    specialCommand?: string | null;
}): WarmAdoptionDecision {
    if (input.specialCommand === 'clear') return { adopt: false, reason: 'clear' };
    if (input.specialCommand === 'compact') return { adopt: false, reason: 'compact' };
    if (claudeModeHash(input.predicted) !== claudeModeHash(input.actual)) return { adopt: false, reason: 'mode-mismatch' };
    const warmPermission = mapToClaudeMode(input.predicted.permissionMode);
    const wantedPermission = mapToClaudeMode(input.actual.permissionMode);
    return {
        adopt: true,
        ...(warmPermission !== wantedPermission ? { setPermissionMode: wantedPermission } : {}),
        switchModel: needsModelSwitch(input.predicted.model, input.actual.model),
    };
}

// ---------------------------------------------------------------------------
// Log lines

export function formatPrewarmLine(event: 'started' | 'adopted' | 'skipped' | 'discarded', detail?: string | Record<string, string | number | boolean | undefined>): string {
    if (event === 'discarded' || event === 'skipped') {
        return `[CLAUDE PREWARM] ${event}(${typeof detail === 'string' ? detail : 'unknown'})`;
    }
    const fields = detail && typeof detail === 'object'
        ? Object.entries(detail).filter(([, v]) => v !== undefined).map(([k, v]) => ` ${k}=${v}`).join('')
        : '';
    return `[CLAUDE PREWARM] ${event}${fields}`;
}

// ---------------------------------------------------------------------------
// Lease: what runClaude hands claudeRemote for ONE warm process.

export interface ClaudePrewarmLease {
    /** Predicted mode the warm Query is created with. */
    readonly mode: EnhancedMode;
    /** Hook settings file whose SessionStart forwarder is tagged with `tag`. */
    readonly hookSettingsPath: string;
    readonly tag: string;
    readonly idleMs: number;
    readonly adoptTimeoutMs: number;
    /** The warm process now serves the session: accept its hooks, free the slot. */
    adopt(): void;
    /** The warm process was closed (or never started): free everything. Idempotent. */
    discard(reason: string): void;
    /** claudeRemote registers the teardown of the live warm Query (wrapper shutdown). */
    setTeardown(teardown: ((reason: string) => void) | null): void;
}

const liveLeases = new Set<ClaudePrewarmLease>();
let exitHookInstalled = false;

/** Close every warm process this wrapper still holds (cleanup/exit/takeover). */
export function disposeAllClaudePrewarms(reason: string): void {
    for (const lease of [...liveLeases]) lease.discard(reason);
}

export function createClaudePrewarmLease(input: {
    mode: EnhancedMode;
    hookSettingsPath: string;
    tag: string;
    gate: PrewarmHookGate;
    slot: PrewarmSlot;
    /** Removes the tagged hook settings file. */
    cleanupHookSettings: () => void;
    log: (line: string) => void;
    idleMs?: number;
    adoptTimeoutMs?: number;
}): ClaudePrewarmLease {
    let state: 'warm' | 'adopted' | 'closed' = 'warm';
    let teardown: ((reason: string) => void) | null = null;
    const lease: ClaudePrewarmLease = {
        mode: input.mode,
        hookSettingsPath: input.hookSettingsPath,
        tag: input.tag,
        idleMs: input.idleMs ?? CLAUDE_PREWARM_IDLE_MS,
        adoptTimeoutMs: input.adoptTimeoutMs ?? CLAUDE_PREWARM_ADOPT_TIMEOUT_MS,
        adopt: () => {
            if (state !== 'warm') return;
            state = 'adopted';
            teardown = null;
            input.gate.adopt(input.tag);
            input.slot.release();
            liveLeases.delete(lease);
        },
        discard: (reason) => {
            if (state !== 'warm') return;
            state = 'closed';
            const t = teardown;
            teardown = null;
            liveLeases.delete(lease);
            try { t?.(reason); } catch { /* teardown is best-effort */ }
            input.slot.release();
            input.cleanupHookSettings();
            input.log(formatPrewarmLine('discarded', reason));
        },
        setTeardown: (next) => { if (state === 'warm') teardown = next; },
    };
    liveLeases.add(lease);
    if (!exitHookInstalled) {
        exitHookInstalled = true;
        // Last line of defence for a path that exits without cleanup():
        // aborting is synchronous (the SDK kills the child on abort).
        process.once('exit', () => disposeAllClaudePrewarms('exit'));
    }
    return lease;
}
