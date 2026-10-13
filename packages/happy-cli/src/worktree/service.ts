/**
 * B-585/B-586 worktree service: create (web), initialize (web/teams/automation),
 * setup status / approve / decline / log, inspect / remove (web-created only).
 * See specs/2026-10-worktree-sessions-and-setup.md.
 *
 * All git calls are argv (`execFile`, never a shell); user-supplied branch and
 * paths are validated before they reach git.
 */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, openSync, readSync, closeSync, statSync, readFileSync, realpathSync, unlinkSync, rmdirSync, mkdirSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import {
    CONFIG_MAX_BYTES, CONFIG_RELATIVE_PATH, describeRunner, parseWorktreeConfig, selectSetupScript, setupScriptHash,
    type ResolvedConfig, type SetupRunner, type WorktreeOrigin,
} from './config';
import { copyIntoWorktree, isInside, linkIntoWorktree } from './materialize';
import { prepareRunner, sanitizeSetupEnv, startSetupRun, type SetupRunHandle } from './setupRunner';
import { WorktreeStore, type WorktreeRecord } from './store';

export const GIT_CREATE_TIMEOUT_MS = 25_000;
export const LOG_CHUNK_BYTES = 64 * 1024;
const MAX_BRANCHES = 200;
const MAX_DIRTY_LISTED = 50;

export class WorktreeError extends Error {
    constructor(readonly code: string, message?: string) { super(message ? `${code}: ${message}` : code); }
}

interface GitResult { code: number; stdout: string; stderr: string }

export function runGit(cwd: string, args: string[], timeoutMs = 15_000): Promise<GitResult> {
    return new Promise((resolvePromise) => {
        execFile('git', ['-C', cwd, ...args], { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (error, stdout, stderr) => {
            const code = error ? (typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === 'number' ? (error as unknown as { code: number }).code : 1) : 0;
            resolvePromise({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') || (error && code !== 0 ? error.message : '') });
        });
    });
}

/** Default location: `<parent of repo>/<repo>.worktrees/<branch with / → ->`. */
export function defaultWorktreeLocation(repoRoot: string, branch: string): string {
    const slug = branch.replace(/[\\/]+/g, '-').replace(/[^A-Za-z0-9._-]/g, '-').replace(/^-+|-+$/g, '') || 'worktree';
    return join(dirname(repoRoot), `${basename(repoRoot)}.worktrees`, slug);
}

/** Parse `git status --porcelain=v1 -z`: paths (renames keep the new path). */
export function parsePorcelainZ(output: string): string[] {
    const parts = output.split('\0');
    const paths: string[] = [];
    for (let i = 0; i < parts.length; i++) {
        const entry = parts[i];
        if (entry.length < 4) continue;
        const status = entry.slice(0, 2);
        paths.push(entry.slice(3).replace(/\/$/, ''));
        if (status[0] === 'R' || status[0] === 'C') i++; // the next token is the source path
    }
    return paths;
}

/** Dirty paths that are NOT our own initialization products. */
export function userDirtyPaths(dirty: string[], managed: { copied: string[]; linked: string[] }): string[] {
    const own = new Set([...managed.copied, ...managed.linked]);
    return dirty.filter((path) => !own.has(path));
}

function real(path: string): string {
    try { return realpathSync(path); } catch { return resolve(path); }
}

function requireAbsolute(path: unknown, field = 'path'): string {
    if (typeof path !== 'string' || !path || !isAbsolute(path) || path.includes('\0')) throw new WorktreeError('invalid-path', `${field} must be an absolute path`);
    return path;
}

export interface WorktreeServiceOptions {
    home: string;
    machineId: string;
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    /** Daemon debug log, injected: importing ui/logger here would pull configuration into every importer. */
    log?: (message: string, error?: unknown) => void;
}

export class WorktreeService {
    readonly store: WorktreeStore;
    private readonly runs = new Map<string, SetupRunHandle>();
    private readonly platform: NodeJS.Platform;
    readonly debug: (message: string, error?: unknown) => void;

    constructor(private readonly opts: WorktreeServiceOptions) {
        this.store = new WorktreeStore(opts.home);
        this.platform = opts.platform ?? process.platform;
        this.debug = opts.log ?? (() => undefined);
        try { this.store.markStaleRunsInterrupted(); } catch (error) { this.debug('[worktree] could not reconcile stale setup runs', error); }
    }

    async toplevel(path: string): Promise<string> {
        const result = await runGit(path, ['rev-parse', '--show-toplevel']);
        if (result.code !== 0) throw new WorktreeError('not-a-git-repo', path);
        return real(result.stdout.trim());
    }

    /** Read `.veryhappy/worktree.json` from the source checkout (never followed outside it). */
    readConfig(root: string, origin: WorktreeOrigin): ResolvedConfig {
        const path = join(root, ...CONFIG_RELATIVE_PATH.split('/'));
        let info;
        try { info = lstatSync(path); } catch { return parseWorktreeConfig(null, origin); }
        try {
            const resolved = realpathSync(path);
            if (!isInside(real(root), resolved)) return { ...parseWorktreeConfig('{}', origin), source: 'invalid', errors: [`${CONFIG_RELATIVE_PATH} points outside the repository`] };
            const size = info.isSymbolicLink() ? statSync(resolved).size : info.size;
            if (size > CONFIG_MAX_BYTES) return { ...parseWorktreeConfig('{}', origin), source: 'invalid', errors: [`${CONFIG_RELATIVE_PATH} exceeds ${CONFIG_MAX_BYTES} bytes`] };
            return parseWorktreeConfig(readFileSync(resolved, 'utf8'), origin);
        } catch (error) {
            return { ...parseWorktreeConfig('{}', origin), source: 'invalid', errors: [`${CONFIG_RELATIVE_PATH}: ${error instanceof Error ? error.message : String(error)}`] };
        }
    }

    private setupFor(root: string, origin: WorktreeOrigin) {
        const resolved = this.readConfig(root, origin);
        const selection = selectSetupScript(resolved.config, this.platform);
        const hash = selection.kind === 'script' ? setupScriptHash(selection.runner, selection.script) : null;
        return { resolved, selection, hash };
    }

    async info(path: string) {
        const root = await this.toplevel(requireAbsolute(path));
        const [head, refs] = await Promise.all([
            runGit(root, ['symbolic-ref', '--short', '-q', 'HEAD']),
            runGit(root, ['for-each-ref', '--sort=-committerdate', `--count=${MAX_BRANCHES}`, '--format=%(refname:short)', 'refs/heads']),
        ]);
        const { resolved, selection, hash } = this.setupFor(root, 'web');
        return {
            repoRoot: root,
            currentBranch: head.code === 0 ? head.stdout.trim() || null : null,
            branches: refs.stdout.split('\n').map((line) => line.trim()).filter(Boolean),
            defaultParent: join(dirname(root), `${basename(root)}.worktrees`),
            config: {
                source: resolved.source,
                copy: resolved.config.copy,
                link: resolved.config.link,
                hasSetup: selection.kind !== 'none',
                setupApproved: hash ? this.store.isApproved(this.opts.machineId, root, hash) : false,
                ...(resolved.errors.length ? { error: resolved.errors.join('; ') } : {}),
            },
        };
    }

    async create(params: { path: unknown; branch: unknown; baseRef: unknown; location: unknown }) {
        const root = await this.toplevel(requireAbsolute(params.path));
        const branch = typeof params.branch === 'string' ? params.branch.trim() : '';
        if (!branch || branch.length > 200) throw new WorktreeError('invalid-branch');
        const refCheck = await runGit(root, ['check-ref-format', '--branch', branch]);
        if (refCheck.code !== 0 || branch.startsWith('-')) throw new WorktreeError('invalid-branch', branch);
        if ((await runGit(root, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])).code === 0) throw new WorktreeError('branch-exists', branch);
        const baseRef = typeof params.baseRef === 'string' && params.baseRef.trim() ? params.baseRef.trim() : 'HEAD';
        if (baseRef.startsWith('-')) throw new WorktreeError('invalid-base', baseRef);
        const base = await runGit(root, ['rev-parse', '--verify', '--quiet', `${baseRef}^{commit}`]);
        if (base.code !== 0) throw new WorktreeError('invalid-base', baseRef);
        const location = typeof params.location === 'string' && params.location.trim()
            ? requireAbsolute(params.location.trim(), 'location')
            : defaultWorktreeLocation(root, branch);
        if (existsSync(location)) throw new WorktreeError('location-exists', location);
        // Real path of the nearest existing ancestor: a location inside the checkout (even via a symlink) is refused.
        let ancestor = dirname(location);
        while (!existsSync(ancestor) && dirname(ancestor) !== ancestor) ancestor = dirname(ancestor);
        if (isInside(root, real(ancestor)) || isInside(root, resolve(location))) throw new WorktreeError('location-inside-repo', location);
        mkdirSync(dirname(location), { recursive: true });
        const added = await runGit(root, ['worktree', 'add', '-b', branch, location, base.stdout.trim()], GIT_CREATE_TIMEOUT_MS);
        if (added.code !== 0) throw new WorktreeError('git-worktree-add-failed', added.stderr.trim().slice(0, 500));
        const worktreePath = real(location);
        const record = await this.initialize({ source: root, worktree: worktreePath, branch, baseRef, origin: 'web' });
        return { worktreePath, branch, baseRef, init: summarize(record) };
    }

    /**
     * Copy → link → setup decision. Returns after materialization; an approved
     * script keeps running in the background. Never throws for config problems.
     */
    async initialize(input: { source: string; worktree: string; branch: string | null; baseRef: string | null; origin: WorktreeOrigin }): Promise<WorktreeRecord> {
        const source = real(input.source);
        const worktree = real(input.worktree);
        const { resolved, selection, hash } = this.setupFor(source, input.origin);
        const copy = resolved.config.copy.length ? await copyIntoWorktree(source, worktree, resolved.config.copy) : { copied: [], skipped: [] };
        const link = resolved.config.link.length ? await linkIntoWorktree(source, worktree, resolved.config.link, this.platform) : { linked: [], skipped: [] };
        const record: WorktreeRecord = {
            repoRoot: source,
            branch: input.branch,
            baseRef: input.baseRef,
            origin: input.origin,
            createdAt: Date.now(),
            copied: copy.copied,
            linked: link.linked,
            skipped: [...copy.skipped, ...link.skipped],
            ...(resolved.errors.length ? { configError: resolved.errors.join('; ') } : {}),
            setup: selection.kind === 'none' ? { state: 'none' }
                : selection.kind === 'unsupported' ? { state: 'unsupported', message: selection.message }
                : { state: 'needs-approval', hash: hash!, runner: selection.runner },
        };
        this.store.put(worktree, record);
        if (selection.kind === 'script' && hash && this.store.isApproved(this.opts.machineId, source, hash)) {
            return this.startRun(worktree, record, selection.script, selection.runner, hash, resolved.config.setupTimeoutMinutes);
        }
        return record;
    }

    private startRun(worktree: string, record: WorktreeRecord, script: string, runner: SetupRunner, hash: string, timeoutMinutes: number): WorktreeRecord {
        const runId = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
        const runDir = this.store.runDir(runId);
        const launch = prepareRunner(runDir, runner, script);
        const handle = startSetupRun({
            launch,
            cwd: worktree,
            env: sanitizeSetupEnv(this.opts.env ?? process.env, { worktree, root: record.repoRoot }),
            logPath: this.store.logPath(runId),
            timeoutMs: timeoutMinutes * 60_000,
        });
        this.runs.set(worktree, handle);
        const next = this.store.updateSetup(worktree, { state: 'running', hash, runner, runId, pid: handle.pid, startedAt: Date.now(), endedAt: undefined, exitCode: undefined, message: undefined })!;
        void handle.done.then((outcome) => {
            this.runs.delete(worktree);
            this.store.updateSetup(worktree, { state: outcome.state, exitCode: outcome.exitCode, endedAt: Date.now(), message: outcome.message });
        }).catch((error) => this.debug('[worktree] setup outcome not recorded', error));
        return next;
    }

    status(path: unknown) {
        const worktree = real(requireAbsolute(path));
        const record = this.store.get(worktree);
        if (!record) return { tracked: false as const };
        const base = { tracked: true as const, worktreePath: worktree, origin: record.origin, branch: record.branch, repoRoot: record.repoRoot, copied: record.copied, linked: record.linked, skipped: record.skipped, ...(record.configError ? { configError: record.configError } : {}), setup: record.setup };
        if (record.setup.state !== 'needs-approval' && record.setup.state !== 'declined') return base;
        const { resolved, selection, hash } = this.setupFor(record.repoRoot, record.origin);
        if (selection.kind !== 'script' || !hash) return base;
        return {
            ...base,
            pending: {
                script: selection.script,
                hash,
                runner: selection.runner,
                runnerLabel: describeRunner(selection.runner),
                cwd: worktree,
                repoRoot: record.repoRoot,
                configPath: join(record.repoRoot, ...CONFIG_RELATIVE_PATH.split('/')),
                timeoutMinutes: resolved.config.setupTimeoutMinutes,
                changedSinceApproval: this.store.hasOtherApproval(this.opts.machineId, record.repoRoot, hash),
            },
        };
    }

    approve(path: unknown, hash: unknown) {
        const worktree = real(requireAbsolute(path));
        const record = this.store.get(worktree);
        if (!record) throw new WorktreeError('not-tracked');
        if (record.setup.state !== 'needs-approval' && record.setup.state !== 'declined') throw new WorktreeError('not-awaiting-approval', record.setup.state);
        const { resolved, selection, hash: current } = this.setupFor(record.repoRoot, record.origin);
        if (selection.kind !== 'script' || !current) throw new WorktreeError('no-setup-script');
        // TOCTOU: the user approved the bytes they SAW. Anything else is a new decision.
        if (typeof hash !== 'string' || hash !== current) throw new WorktreeError('script-changed');
        this.store.approve({ machineId: this.opts.machineId, repoRoot: record.repoRoot, hash: current, runner: selection.runner, approvedAt: Date.now() });
        this.startRun(worktree, record, selection.script, selection.runner, current, resolved.config.setupTimeoutMinutes);
        return this.status(worktree);
    }

    decline(path: unknown) {
        const worktree = real(requireAbsolute(path));
        const record = this.store.get(worktree);
        if (!record) throw new WorktreeError('not-tracked');
        if (record.setup.state === 'needs-approval') this.store.updateSetup(worktree, { state: 'declined', endedAt: Date.now() });
        return this.status(worktree);
    }

    log(path: unknown, offset: unknown) {
        const worktree = real(requireAbsolute(path));
        const record = this.store.get(worktree);
        const runId = record?.setup.runId;
        if (!record || !runId) return { text: '', offset: 0, size: 0, done: true };
        const logPath = this.store.logPath(runId);
        if (!existsSync(logPath)) return { text: '', offset: 0, size: 0, done: record.setup.state !== 'running' };
        const size = statSync(logPath).size;
        const start = typeof offset === 'number' && offset >= 0 && offset <= size ? Math.floor(offset) : 0;
        const length = Math.min(LOG_CHUNK_BYTES, size - start);
        const buffer = Buffer.alloc(length);
        if (length > 0) {
            const fd = openSync(logPath, 'r');
            try { readSync(fd, buffer, 0, length, start); } finally { closeSync(fd); }
        }
        return { text: buffer.toString('utf8'), offset: start + length, size, done: record.setup.state !== 'running' && start + length >= size };
    }

    async inspect(path: unknown) {
        const worktree = real(requireAbsolute(path));
        const record = this.store.get(worktree);
        if (!record) return { removable: false, reason: 'not-tracked', dirty: [] as string[], dirtyCount: 0, branch: null };
        if (record.origin !== 'web') return { removable: false, reason: `owned-by-${record.origin}`, dirty: [], dirtyCount: 0, branch: record.branch };
        const gitFile = join(worktree, '.git');
        if (!existsSync(gitFile) || !lstatSync(gitFile).isFile()) return { removable: false, reason: 'not-a-linked-worktree', dirty: [], dirtyCount: 0, branch: record.branch };
        const status = await runGit(worktree, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
        if (status.code !== 0) return { removable: false, reason: 'git-status-failed', dirty: [], dirtyCount: 0, branch: record.branch };
        const dirty = userDirtyPaths(parsePorcelainZ(status.stdout), record);
        const head = await runGit(worktree, ['symbolic-ref', '--short', '-q', 'HEAD']);
        return { removable: true, dirty: dirty.slice(0, MAX_DIRTY_LISTED), dirtyCount: dirty.length, branch: head.stdout.trim() || record.branch };
    }

    async remove(path: unknown, discardChanges: unknown) {
        const worktree = real(requireAbsolute(path));
        const inspection = await this.inspect(worktree);
        if (!inspection.removable) throw new WorktreeError('not-removable', inspection.reason);
        if (inspection.dirtyCount > 0 && discardChanges !== true) throw new WorktreeError('dirty', String(inspection.dirtyCount));
        const record = this.store.get(worktree)!;
        this.runs.get(worktree)?.stop();
        // Drop our links first so a recursive delete can never walk into the shared target.
        for (const rel of record.linked) {
            const target = join(worktree, ...rel.split('/'));
            try {
                const info = lstatSync(target);
                if (info.isSymbolicLink()) unlinkSync(target);
                else if (this.platform === 'win32') rmdirSync(target); // a junction: removes the link, not the target
            } catch { /* already gone */ }
        }
        const removed = await runGit(record.repoRoot, ['worktree', 'remove', '--force', worktree], GIT_CREATE_TIMEOUT_MS);
        if (removed.code !== 0) throw new WorktreeError('git-worktree-remove-failed', removed.stderr.trim().slice(0, 500));
        this.store.remove(worktree);
        return { removed: true, branch: inspection.branch };
    }

    /** Daemon shutdown: kill every running setup tree (recorded as interrupted). */
    stopAll(): void {
        for (const handle of this.runs.values()) handle.stop();
    }
}

export function summarize(record: WorktreeRecord) {
    return { copied: record.copied, linked: record.linked, skipped: record.skipped, ...(record.configError ? { configError: record.configError } : {}), setup: { state: record.setup.state, ...(record.setup.message ? { message: record.setup.message } : {}) } };
}

let current: WorktreeService | null = null;

/** The daemon's service (created by the machine client). Null outside a daemon (tests, CLI). */
export function configureWorktreeService(opts: WorktreeServiceOptions): WorktreeService {
    if (!current || current.store.dir !== new WorktreeStore(opts.home).dir) current = new WorktreeService(opts);
    return current;
}

export function currentWorktreeService(): WorktreeService | null {
    return current;
}

/** Teams / Automations hook: never throws; scripts only run when already approved. */
export async function initializeOwnedWorktree(input: { source: string; worktree: string; branch: string; origin: 'teams' | 'automation' }): Promise<void> {
    const service = currentWorktreeService();
    if (!service) return;
    try {
        const source = await service.toplevel(input.source);
        await service.initialize({ ...input, source, baseRef: null });
    } catch (error) {
        service.debug(`[worktree] ${input.origin} worktree initialization failed`, error);
    }
}
