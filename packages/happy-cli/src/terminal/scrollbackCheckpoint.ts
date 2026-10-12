/**
 * B-550 terminal scrollback persistence — the I/O half.
 *
 * Owns `<HAPPY_HOME_DIR>/terminal-scrollback/` (0700, files 0600) and the three
 * moments the manager (webTerminal.ts) hooks it into:
 *
 *   tick(closedIds)    — every list-track tick: async, single-flight probe +
 *                        capture of the terminals whose output went quiet;
 *   promote(id)        — a terminal is about to be REBUILT (auto-restore /
 *                        ↻ restore): its last checkpoint becomes the archive;
 *   replayFor(id)      — a capture is being assembled for a web open: the
 *                        archive to put above it (spec D4);
 *   flushOnShutdown()  — the daemon is exiting: synchronous best-effort
 *                        capture of everything dirty, bounded in time.
 *
 * Rules live in scrollbackArchive.ts; this file only does tmux + fs. Nothing
 * here ever writes to a pane: replayed bytes travel to the web only.
 * Spec: specs/2026-10-terminal-scrollback-persistence.md.
 */
import { execFile, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '@/ui/logger';
import { tmuxArgs } from './tmuxSocket';
import {
    ACTIVITY_RESOLUTION_MS,
    CHECKPOINT_PROBE_FORMAT,
    SCROLLBACK_FILE_MAX_BYTES,
    archiveFileName,
    buildCheckpointBody,
    chainArchive,
    checkpointCaptureArgs,
    decodeArchiveFile,
    encodeArchiveFile,
    parseArchiveFileName,
    parseCheckpointProbe,
    planCheckpoints,
    planScrollbackGc,
    resolveScrollbackConfig,
    SCROLLBACK_PERSIST_DEFAULT,
    type ArchiveFile,
    type ArchiveFileEntry,
    type ArchiveKind,
    type CheckpointState,
    type ProbedTerminal,
} from './scrollbackArchive';

/** Re-read settings.json at most this often. */
const CONFIG_REFRESH_MS = 60_000;
/** GC at most this often (and on the first tick). */
const GC_INTERVAL_MS = 10 * 60_000;
/** Shutdown flush: total wall-clock budget. */
export const SHUTDOWN_FLUSH_BUDGET_MS = 1_500;
const TMUX_TIMEOUT_MS = 5_000;
/** A 5000-line capture with SGR is well under this; it only bounds a runaway. */
const TMUX_MAX_BUFFER = 32 * 1024 * 1024;

export interface ScrollbackTmux {
    /** Async run; resolves stdout, or null on any failure. */
    run(args: string[]): Promise<Buffer | null>;
    /** Sync run with a timeout; stdout or null. Shutdown only. */
    runSync(args: string[], timeoutMs: number): Buffer | null;
}

export interface ScrollbackCheckpointerOptions {
    /** Directory root (HAPPY_HOME_DIR), read lazily so tests can repoint it. */
    homeDir: () => string;
    /** Client env for tmux (the manager's ptyEnv: UTF-8 locale, no $TMUX). */
    env: () => Record<string, string>;
    /** Injectable for tests. */
    tmux?: ScrollbackTmux;
    /** Sync settings read (default: `<homeDir>/settings.json`, tolerant). */
    readConfig?: () => { enabled: boolean };
    now?: () => number;
}

function defaultTmux(env: () => Record<string, string>): ScrollbackTmux {
    return {
        run: (args) => new Promise((resolve) => {
            try {
                execFile('tmux', tmuxArgs(args), { env: env(), encoding: 'buffer', timeout: TMUX_TIMEOUT_MS, maxBuffer: TMUX_MAX_BUFFER },
                    (err, stdout) => resolve(err ? null : stdout));
            } catch {
                resolve(null);
            }
        }),
        runSync: (args, timeoutMs) => {
            try {
                const r = spawnSync('tmux', tmuxArgs(args), { env: env(), timeout: Math.max(1, timeoutMs), maxBuffer: TMUX_MAX_BUFFER });
                return r.status === 0 && r.stdout ? r.stdout : null;
            } catch {
                return null;
            }
        },
    };
}

export class ScrollbackCheckpointer {
    private readonly opts: ScrollbackCheckpointerOptions;
    private readonly tmux: ScrollbackTmux;
    private readonly now: () => number;
    private readonly readConfig: () => { enabled: boolean };
    /** Cached switch; the default until settings were read once. */
    private enabled = SCROLLBACK_PERSIST_DEFAULT;
    private configReadAt = 0;
    private lastGcAt = 0;
    private busy = false;
    /** Set once a tick ran in this process — the shutdown flush is a no-op
     *  before that (unit tests that only construct+stop never touch tmux). */
    private started = false;
    private stopped = false;
    private readonly state = new Map<string, CheckpointState>();
    /** Bumped by promote(): an in-flight capture of an earlier generation must
     *  not overwrite `.live` after the promotion moved it to `.prev`. */
    private readonly generation = new Map<string, number>();

    constructor(opts: ScrollbackCheckpointerOptions) {
        this.opts = opts;
        this.tmux = opts.tmux ?? defaultTmux(opts.env);
        this.now = opts.now ?? Date.now;
        this.readConfig = opts.readConfig ?? (() => {
            try {
                return resolveScrollbackConfig(JSON.parse(readFileSync(join(this.opts.homeDir(), 'settings.json'), 'utf8')));
            } catch {
                return resolveScrollbackConfig(null);
            }
        });
    }

    dir(): string {
        return join(this.opts.homeDir(), 'terminal-scrollback');
    }

    private filePath(id: string, kind: ArchiveKind): string {
        return join(this.dir(), archiveFileName(id, kind));
    }

    isEnabled(): boolean {
        this.refreshConfig();
        return this.enabled;
    }

    // ── tick ────────────────────────────────────────────────────────────────

    /** Fire-and-forget from the list-track tick. Never throws. */
    tick(closedIds: readonly string[]): void {
        if (this.busy || this.stopped) return;
        this.busy = true;
        this.started = true;
        void this.runTick(closedIds)
            .catch((e) => logger.debug(`[SCROLLBACK] tick failed: ${e}`))
            .finally(() => { this.busy = false; });
    }

    /** One tick, awaitable (tests). */
    async runTick(closedIds: readonly string[]): Promise<void> {
        this.started = true;
        this.refreshConfig();
        if (!this.enabled) return;
        const out = await this.tmux.run(['list-sessions', '-F', CHECKPOINT_PROBE_FORMAT]);
        const probed = out ? parseCheckpointProbe(out.toString('utf8')) : null;
        if (probed) {
            this.seedState(probed);
            const now = this.now();
            for (const id of planCheckpoints(probed, this.state, now)) {
                if (this.stopped || !this.enabled) break;
                const t = probed.find((p) => p.id === id)!;
                await this.checkpointOne(t);
            }
        }
        this.maybeGc(probed ? new Set([...probed.map((p) => p.id), ...closedIds]) : null);
    }

    /** Re-read the switch (at most every CONFIG_REFRESH_MS; always on first
     *  use, so a replay right after daemon start already honours `false`). */
    private refreshConfig(): void {
        const now = this.now();
        if (this.configReadAt && now - this.configReadAt < CONFIG_REFRESH_MS) return;
        this.configReadAt = now;
        let enabled = SCROLLBACK_PERSIST_DEFAULT;
        try { enabled = this.readConfig().enabled; } catch { /* default */ }
        const turnedOff = this.enabled && !enabled;
        this.enabled = enabled;
        if (!enabled) {
            if (turnedOff) logger.info('[SCROLLBACK] terminalScrollbackPersist=false: deleting saved terminal scrollback');
            this.purge();
        }
    }

    /** First sight of an id after a daemon start: an existing `.live` file
     *  counts as the last checkpoint (by mtime), so a restart does not re-take
     *  every terminal at once. */
    private seedState(probed: readonly ProbedTerminal[]): void {
        for (const t of probed) {
            if (this.state.has(t.id)) continue;
            try {
                // mtime is the END of that capture; one second back is a
                // conservative start (at worst one redundant checkpoint).
                const mtime = statSync(this.filePath(t.id, 'live')).mtimeMs;
                this.state.set(t.id, { at: mtime - ACTIVITY_RESOLUTION_MS });
            } catch { /* no file → dirty */ }
        }
    }

    private async checkpointOne(t: ProbedTerminal): Promise<void> {
        const gen = this.generation.get(t.id) ?? 0;
        const startedAt = this.now();
        const parts: Buffer[] = [];
        for (const args of checkpointCaptureArgs(t.id, t.alternateOn)) {
            const out = await this.tmux.run(args);
            if (!out) return; // session gone / tmux hiccup: try again next tick
            parts.push(out);
        }
        if ((this.generation.get(t.id) ?? 0) !== gen || this.stopped || !this.enabled) return;
        this.writeLive(t.id, buildCheckpointBody(parts), this.now());
        this.state.set(t.id, { at: startedAt });
    }

    private writeLive(id: string, body: Buffer, now: number): void {
        if (body.length === 0) {
            this.removeFile(id, 'live');
            return;
        }
        this.writeFile(id, 'live', { savedAt: now, body });
    }

    // ── promote / replay ────────────────────────────────────────────────────

    /**
     * Spec D3: called right before a terminal is rebuilt (new tmux session,
     * same id). `.live` (the life that ended) is chained onto `.prev` and
     * removed. Synchronous on purpose — the caller creates the session in the
     * same turn, so no async capture can slip in between.
     */
    promote(id: string): void {
        this.generation.set(id, (this.generation.get(id) ?? 0) + 1);
        this.state.delete(id);
        if (!this.isEnabled()) return;
        try {
            const live = decodeArchiveFile(this.readFile(id, 'live'));
            const prev = decodeArchiveFile(this.readFile(id, 'prev'));
            const chained = chainArchive(prev, live);
            if (chained && live) this.writeFile(id, 'prev', chained);
            this.removeFile(id, 'live');
        } catch (e) {
            logger.debug(`[SCROLLBACK] promote ${id} failed: ${e}`);
        }
    }

    /** The archive to replay above a capture of `id`, or null. */
    replayFor(id: string): ArchiveFile | null {
        if (!this.isEnabled()) return null;
        try {
            return decodeArchiveFile(this.readFile(id, 'prev'));
        } catch {
            return null;
        }
    }

    // ── shutdown ────────────────────────────────────────────────────────────

    /**
     * Daemon exit: synchronously capture every terminal with output newer than
     * its last checkpoint, within SHUTDOWN_FLUSH_BUDGET_MS. Best-effort — on a
     * machine shutdown tmux may already be gone, and the periodic checkpoint is
     * the real guarantee.
     */
    flushOnShutdown(budgetMs = SHUTDOWN_FLUSH_BUDGET_MS): void {
        if (this.stopped) return;
        this.stopped = true;
        if (!this.started || !this.enabled) return;
        const deadline = Date.now() + budgetMs;
        const left = () => deadline - Date.now();
        try {
            const out = this.tmux.runSync(['list-sessions', '-F', CHECKPOINT_PROBE_FORMAT], Math.min(500, left()));
            if (!out) return;
            const probed = parseCheckpointProbe(out.toString('utf8'));
            this.seedState(probed);
            const dirty = planCheckpoints(probed, this.state, this.now(), {
                quietMs: 0, minIntervalMs: 0, maxDirtyMs: 0, max: Number.MAX_SAFE_INTEGER,
            });
            let written = 0;
            for (const id of dirty) {
                if (left() <= 0) break;
                const t = probed.find((p) => p.id === id)!;
                const startedAt = this.now();
                const parts: Buffer[] = [];
                for (const args of checkpointCaptureArgs(id, t.alternateOn)) {
                    const timeout = left();
                    const part = timeout > 0 ? this.tmux.runSync(args, timeout) : null;
                    if (!part) { parts.length = 0; break; }
                    parts.push(part);
                }
                if (parts.length === 0) continue;
                this.writeLive(id, buildCheckpointBody(parts), this.now());
                this.state.set(id, { at: startedAt });
                written++;
            }
            if (dirty.length > 0) logger.debug(`[SCROLLBACK] shutdown flush: ${written}/${dirty.length} terminal(s)`);
        } catch (e) {
            logger.debug(`[SCROLLBACK] shutdown flush failed: ${e}`);
        }
    }

    // ── fs ──────────────────────────────────────────────────────────────────

    private ensureDir(): string {
        const dir = this.dir();
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        try { chmodSync(dir, 0o700); } catch { /* best-effort */ }
        return dir;
    }

    private readFile(id: string, kind: ArchiveKind): Buffer | null {
        try {
            const p = this.filePath(id, kind);
            // A file can only exceed the cap if something else wrote it; read
            // no more than cap + header slack either way.
            if (statSync(p).size > SCROLLBACK_FILE_MAX_BYTES * 2) return null;
            return readFileSync(p);
        } catch {
            return null;
        }
    }

    private writeFile(id: string, kind: ArchiveKind, file: ArchiveFile): void {
        try {
            this.ensureDir();
            const target = this.filePath(id, kind);
            const tmp = `${target}.${process.pid}.tmp`;
            writeFileSync(tmp, encodeArchiveFile(file), { mode: 0o600 });
            chmodSync(tmp, 0o600);
            renameSync(tmp, target);
        } catch (e) {
            logger.debug(`[SCROLLBACK] write ${id}.${kind} failed: ${e}`);
        }
    }

    private removeFile(id: string, kind: ArchiveKind): void {
        try { unlinkSync(this.filePath(id, kind)); } catch { /* absent */ }
    }

    private listFiles(): ArchiveFileEntry[] {
        let names: string[];
        try { names = readdirSync(this.dir()); } catch { return []; }
        const out: ArchiveFileEntry[] = [];
        for (const name of names) {
            try {
                const st = statSync(join(this.dir(), name));
                if (!st.isFile()) continue;
                const parsed = parseArchiveFileName(name);
                out.push({ name, id: parsed?.id ?? null, kind: parsed?.kind ?? null, mtimeMs: st.mtimeMs, bytes: st.size });
            } catch { /* raced away */ }
        }
        return out;
    }

    private maybeGc(keepIds: ReadonlySet<string> | null): void {
        const now = this.now();
        if (this.lastGcAt && now - this.lastGcAt < GC_INTERVAL_MS) return;
        this.lastGcAt = now;
        this.gc(keepIds, now);
    }

    /** Exposed for tests. */
    gc(keepIds: ReadonlySet<string> | null, now = this.now()): string[] {
        const doomed = planScrollbackGc(this.listFiles(), keepIds, now);
        for (const name of doomed) {
            try { unlinkSync(join(this.dir(), name)); } catch { /* gone */ }
        }
        if (doomed.length > 0) logger.debug(`[SCROLLBACK] gc removed ${doomed.length} file(s)`);
        return doomed;
    }

    /** Switch turned off: the saved scrollback goes away entirely. */
    private purge(): void {
        try { rmSync(this.dir(), { recursive: true, force: true }); } catch { /* best-effort */ }
        this.state.clear();
    }
}
