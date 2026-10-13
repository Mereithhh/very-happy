/**
 * B-585 daemon-local trust + worktree registry under
 * `HAPPY_HOME/worktree-setup/` (0700 dir, 0600 files). Never synced to the
 * server: trusting a script is a fact about THIS machine.
 */
import { existsSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ensurePrivateDirectorySync, writePrivateFileSync } from '@/utils/secureFiles';
import type { SetupRunner, WorktreeOrigin } from './config';
import type { SkippedPath } from './materialize';

export const MAX_APPROVALS = 500;
export const MAX_WORKTREES = 500;
/** Run directories (approved script snapshot + output log) kept on disk. */
export const MAX_RUN_DIRS = 100;

export interface Approval { machineId: string; repoRoot: string; hash: string; runner: SetupRunner; approvedAt: number }

export type SetupState = 'none' | 'needs-approval' | 'declined' | 'running' | 'succeeded' | 'failed' | 'timed-out' | 'interrupted' | 'unsupported';

export interface SetupRecord {
    state: SetupState;
    hash?: string;
    runner?: SetupRunner;
    runId?: string;
    pid?: number;
    startedAt?: number;
    endedAt?: number;
    exitCode?: number | null;
    message?: string;
    truncated?: boolean;
}

export interface WorktreeRecord {
    repoRoot: string;
    branch: string | null;
    baseRef: string | null;
    origin: WorktreeOrigin;
    createdAt: number;
    copied: string[];
    linked: string[];
    skipped: SkippedPath[];
    configError?: string;
    /** Materialization failed part-way (the worktree still exists and stays removable). */
    initError?: string;
    setup: SetupRecord;
}

export class WorktreeStore {
    readonly dir: string;
    constructor(home: string) { this.dir = join(home, 'worktree-setup'); }

    private file(name: string): string { return join(this.dir, name); }

    private read<T>(name: string, fallback: T): T {
        const path = this.file(name);
        if (!existsSync(path)) return fallback;
        try { return JSON.parse(readFileSync(path, 'utf8')) as T; } catch { return fallback; }
    }

    private write(name: string, value: unknown): void {
        ensurePrivateDirectorySync(this.dir);
        const path = this.file(name);
        const tmp = `${path}.${process.pid}.tmp`;
        writePrivateFileSync(tmp, JSON.stringify(value, null, 2));
        renameSync(tmp, path);
    }

    runDir(runId: string): string {
        const dir = join(this.dir, 'runs', runId);
        ensurePrivateDirectorySync(dir);
        return dir;
    }

    logPath(runId: string): string { return join(this.dir, 'runs', runId, 'output.log'); }

    /** Keep the newest MAX_RUN_DIRS runs (run ids start with a base36 timestamp, so names sort by age). */
    pruneRuns(keep: ReadonlySet<string> = new Set(), max = MAX_RUN_DIRS): number {
        const root = join(this.dir, 'runs');
        let names: string[];
        try { names = readdirSync(root).sort(); } catch { return 0; }
        let removed = 0;
        for (const name of names.slice(0, Math.max(0, names.length - max))) {
            if (keep.has(name)) continue;
            try { rmSync(join(root, name), { recursive: true, force: true }); removed++; } catch { /* in use / gone */ }
        }
        return removed;
    }

    // ── approvals ──
    approvals(): Approval[] {
        const data = this.read<{ approvals?: Approval[] }>('approvals.json', {});
        return Array.isArray(data.approvals) ? data.approvals : [];
    }

    isApproved(machineId: string, repoRoot: string, hash: string): boolean {
        return this.approvals().some((a) => a.machineId === machineId && a.repoRoot === repoRoot && a.hash === hash);
    }

    /** True when this repo has SOME approval but not for `hash` (the script changed). */
    hasOtherApproval(machineId: string, repoRoot: string, hash: string): boolean {
        return this.approvals().some((a) => a.machineId === machineId && a.repoRoot === repoRoot && a.hash !== hash);
    }

    approve(entry: Approval): void {
        const rest = this.approvals().filter((a) => !(a.machineId === entry.machineId && a.repoRoot === entry.repoRoot && a.hash === entry.hash));
        const next = [...rest, entry].sort((a, b) => a.approvedAt - b.approvedAt).slice(-MAX_APPROVALS);
        this.write('approvals.json', { version: 1, approvals: next });
    }

    // ── worktree registry ──
    worktrees(): Record<string, WorktreeRecord> {
        const data = this.read<{ worktrees?: Record<string, WorktreeRecord> }>('worktrees.json', {});
        return data.worktrees && typeof data.worktrees === 'object' ? data.worktrees : {};
    }

    get(worktree: string): WorktreeRecord | undefined { return this.worktrees()[worktree]; }

    put(worktree: string, record: WorktreeRecord): void {
        const all = { ...this.worktrees(), [worktree]: record };
        const keys = Object.keys(all).sort((a, b) => all[a].createdAt - all[b].createdAt);
        for (const key of keys.slice(0, Math.max(0, keys.length - MAX_WORKTREES))) delete all[key];
        this.write('worktrees.json', { version: 1, worktrees: all });
    }

    updateSetup(worktree: string, patch: Partial<SetupRecord>): WorktreeRecord | undefined {
        const record = this.get(worktree);
        if (!record) return undefined;
        const next = { ...record, setup: { ...record.setup, ...patch } };
        this.put(worktree, next);
        return next;
    }

    remove(worktree: string): void {
        const all = this.worktrees();
        if (!(worktree in all)) return;
        delete all[worktree];
        this.write('worktrees.json', { version: 1, worktrees: all });
    }

    /**
     * Daemon start: any `running` record belongs to a previous daemon process
     * (this one has not started anything yet) — it was cut off. Never re-run.
     */
    markStaleRunsInterrupted(now = Date.now()): Array<{ worktree: string; pid?: number; runId?: string }> {
        const all = this.worktrees();
        const cut: Array<{ worktree: string; pid?: number; runId?: string }> = [];
        for (const [worktree, record] of Object.entries(all)) {
            if (record.setup.state === 'running') {
                cut.push({ worktree, pid: record.setup.pid, runId: record.setup.runId });
                record.setup = { ...record.setup, state: 'interrupted', endedAt: now, message: 'Daemon stopped during setup' };
            }
        }
        if (cut.length) this.write('worktrees.json', { version: 1, worktrees: all });
        return cut;
    }
}
