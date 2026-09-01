/**
 * B-276 — daemon-side orchestration for the Claude auth preflight. Owns the
 * schedule (startup, 10 min, signal-triggered, RPC), the darwin diagnoser, the
 * confirm-gated repair, and the credentialStore=file shim. Publishes through
 * the injected `publish` (apiMachine.setClaudeAuthState) and never logs tokens.
 */
import { execFile, spawn } from 'node:child_process';
import { accessSync, constants, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '@/ui/logger';
import {
    buildClaudeAuthState, classifyAuthStatus, classifyLineage, claudeAuthStateChanged, diagnoseStores,
    interpretCredentialsFile, interpretSecurityRead, keychainOffShimDir, keychainIdentityFor, parseLaunchctlPid,
    resolveSdkClaudeBinary, securityDeleteArgs, securityReadArgs, withKeychainOffPath,
    HAPPY_DAEMON_LAUNCHD_LABEL,
    type ClaudeAuthLineage, type ClaudeAuthState, type ClaudeCredentialStore, type DiagnosisResult, type ProbeRun, type SecurityResult,
} from './claudeAuthProbe';

export const CLAUDE_AUTH_PROBE_INTERVAL_MS = 10 * 60 * 1000;
export const CLAUDE_AUTH_REFRESH_INTERVAL_MS = 30 * 60 * 1000;
const PROBE_TIMEOUT_MS = 8000;
const SECURITY_TIMEOUT_MS = 3000;
const SIGNAL_DEBOUNCE_MS = 1000;

export interface ClaudeAuthServiceOptions {
    happyHomeDir: string;
    happyLibDir: string;
    credentialSource: string | undefined;
    getCredentialStore: () => ClaudeCredentialStore;
    setCredentialStore: (store: ClaudeCredentialStore) => Promise<void>;
    publish: (state: ClaudeAuthState) => Promise<boolean>;
    env?: NodeJS.ProcessEnv;
    platform?: string;
    now?: () => number;
}

export class ClaudeAuthService {
    private timer: NodeJS.Timeout | null = null;
    private signalTimer: NodeJS.Timeout | null = null;
    private inFlight: Promise<ClaudeAuthState> | null = null;
    private last: ClaudeAuthState | null = null;
    private dirty = false;
    private lastPublishedAt = 0;
    private lineage: ClaudeAuthLineage | null = null;
    private lastDiagnosis: DiagnosisResult | undefined;
    private readonly env: NodeJS.ProcessEnv;
    private readonly platform: string;

    constructor(private readonly opts: ClaudeAuthServiceOptions) {
        this.env = opts.env ?? process.env;
        this.platform = opts.platform ?? process.platform;
    }

    start(): void {
        setTimeout(() => void this.probe('startup'), 2000).unref();
        this.timer = setInterval(() => void this.probe('interval'), CLAUDE_AUTH_PROBE_INTERVAL_MS);
        this.timer.unref();
    }

    stop(): void {
        if (this.timer) clearInterval(this.timer);
        if (this.signalTimer) clearTimeout(this.signalTimer);
        this.timer = null;
        this.signalTimer = null;
    }

    current(): ClaudeAuthState | null {
        return this.last;
    }

    /** D3: a session reported `authentication_failed`; re-probe after a short debounce. */
    signalAuthFailed(sessionId: string): void {
        logger.debug(`[CLAUDE AUTH] auth_failed signal from session ${sessionId}`);
        if (this.signalTimer) clearTimeout(this.signalTimer);
        this.signalTimer = setTimeout(() => { this.signalTimer = null; void this.probe('signal', true); }, SIGNAL_DEBOUNCE_MS);
        this.signalTimer.unref();
    }

    /** Env the SDK/one-shot Claude Code processes should get for the current store setting. */
    claudeProcessEnvOverrides(): Record<string, string> {
        if (this.opts.getCredentialStore() !== 'file') return {};
        const shim = this.resolveShimDir();
        if (!shim) return {};
        return { PATH: withKeychainOffPath(this.env.PATH, shim) };
    }

    effectiveCredentialStore(): ClaudeCredentialStore {
        if (this.opts.getCredentialStore() !== 'file') return 'auto';
        return this.resolveShimDir() ? 'file' : 'auto';
    }

    async probe(reason: string, withDiagnosis = false): Promise<ClaudeAuthState> {
        if (this.inFlight) return this.inFlight;
        this.inFlight = this.runProbe(reason, withDiagnosis).finally(() => { this.inFlight = null; });
        return this.inFlight;
    }

    async setStore(store: ClaudeCredentialStore): Promise<ClaudeAuthState> {
        await this.opts.setCredentialStore(store);
        return this.probe('set-store', true);
    }

    /** D4: delete the empty-token keychain item after re-validating every precondition. */
    async repair(action: string): Promise<{ ok: true; claudeAuth: ClaudeAuthState } | { error: string; claudeAuth: ClaudeAuthState | null }> {
        if (action !== 'delete-empty-keychain-item') return { error: 'unknown-action', claudeAuth: this.last };
        if (this.platform !== 'darwin' || this.effectiveCredentialStore() === 'file') return { error: 'precondition-failed', claudeAuth: this.last };
        const state = await this.probe('repair-precheck', true);
        const seen = this.lastDiagnosis;
        if (state.diagnosis !== 'keychain-empty-item' || !seen?.keychainRaw) return { error: 'precondition-failed', claudeAuth: state };
        const identity = keychainIdentityFor(this.env);
        const again = interpretSecurityRead(await this.security(securityReadArgs(identity)));
        if (again.kind !== 'present' || again.raw !== seen.keychainRaw || again.accessToken || again.refreshToken) {
            return { error: 'precondition-failed', claudeAuth: state };
        }
        try {
            const dir = join(this.opts.happyHomeDir, 'backups');
            mkdirSync(dir, { recursive: true, mode: 0o700 });
            writeFileSync(join(dir, `claude-keychain-${Date.now()}.json`), again.raw + '\n', { mode: 0o600 });
        } catch (error) {
            return { error: `backup-failed: ${String(error)}`, claudeAuth: state };
        }
        const del = await this.security(securityDeleteArgs(identity));
        if (del.exitCode !== 0) return { error: `delete-failed: security exited ${del.exitCode ?? 'null'}`, claudeAuth: state };
        logger.debug('[CLAUDE AUTH] deleted empty-token keychain item after backup');
        const after = await this.probe('repair-done', true);
        return { ok: true, claudeAuth: after };
    }

    // ── internals ────────────────────────────────────────────────────────

    private resolveShimDir(): string | null {
        const dir = keychainOffShimDir(this.opts.happyLibDir);
        const bin = join(dir, 'security');
        try {
            if (!statSync(bin).isFile()) return null;
            accessSync(bin, constants.X_OK);
            return dir;
        } catch {
            return null;
        }
    }

    private async runProbe(reason: string, withDiagnosis: boolean): Promise<ClaudeAuthState> {
        const store = this.effectiveCredentialStore();
        const storeRequested = this.opts.getCredentialStore();
        const classification = await this.runAuthStatus();
        let diagnosis: DiagnosisResult | undefined;
        this.lastDiagnosis = undefined;
        if (this.platform === 'darwin' && store !== 'file'
            && (classification.status === 'not-logged-in' || (withDiagnosis && classification.status !== 'unknown'))) {
            diagnosis = await this.diagnose(classification.status);
            this.lastDiagnosis = diagnosis;
        } else if (classification.status === 'not-logged-in' && store === 'file') {
            const file = interpretCredentialsFile(this.readCredentialsFile());
            if (!file.hasTokens) diagnosis = { diagnosis: 'no-credentials', detail: 'credentialStore=file and ~/.claude/.credentials.json has no tokens; log in with `claude` from a terminal on this machine.' };
        }
        if (storeRequested === 'file' && store === 'auto') {
            diagnosis = { ...(diagnosis ?? {}), detail: `credentialStore=file requested but the keychain-off shim is missing under ${keychainOffShimDir(this.opts.happyLibDir)}; running in auto mode.` };
        }
        const state = buildClaudeAuthState({
            daemonPid: process.pid,
            platform: this.platform,
            lineage: await this.resolveLineage(),
            credentialStore: store,
            classification,
            diagnosis,
            now: this.opts.now?.() ?? Date.now(),
        });
        const changed = claudeAuthStateChanged(this.last, state);
        const stale = state.checkedAt - this.lastPublishedAt >= CLAUDE_AUTH_REFRESH_INTERVAL_MS;
        if (changed) {
            logger.debug(`[CLAUDE AUTH] ${reason}: status=${state.status} diagnosis=${state.diagnosis ?? '-'} lineage=${state.context.lineage} store=${state.context.credentialStore}`);
        }
        this.last = state;
        if (changed || stale || this.dirty) {
            const ok = await this.opts.publish(state).catch((error) => { logger.debug('[CLAUDE AUTH] publish failed:', error); return false; });
            this.dirty = !ok;
            if (ok) this.lastPublishedAt = state.checkedAt;
            else logger.warn('[CLAUDE AUTH] daemonState publish did not land; will force resend on the next probe');
        }
        return state;
    }

    private async runAuthStatus() {
        const binary = resolveSdkClaudeBinary(this.platform, process.arch);
        if (!binary) {
            return { status: 'claude-missing' as const, diagnosis: 'sdk-binary-missing' as const, detail: 'The Claude Code binary bundled with the Agent SDK is missing; remote sessions cannot start.' };
        }
        const cwd = join(this.opts.happyHomeDir, 'tmp', 'auth-probe');
        try { mkdirSync(cwd, { recursive: true }); } catch { /* ignore */ }
        const env: NodeJS.ProcessEnv = { ...this.env, ...this.claudeProcessEnvOverrides() };
        const run = await new Promise<ProbeRun>((resolve) => {
            let stdout = '';
            let settled = false;
            const done = (r: ProbeRun) => { if (!settled) { settled = true; resolve(r); } };
            let child: ReturnType<typeof spawn>;
            try {
                child = spawn(binary, ['auth', 'status'], { cwd, env, stdio: ['ignore', 'pipe', 'ignore'] });
            } catch (error) {
                done({ stdout: '', exitCode: null, timedOut: false, spawnError: String(error) });
                return;
            }
            const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } done({ stdout, exitCode: null, timedOut: true }); }, PROBE_TIMEOUT_MS);
            child.stdout?.on('data', (chunk: Buffer) => { if (stdout.length < 65536) stdout += chunk.toString('utf8'); });
            child.on('error', (error) => { clearTimeout(timer); done({ stdout, exitCode: null, timedOut: false, spawnError: String(error) }); });
            child.on('close', (code) => { clearTimeout(timer); done({ stdout, exitCode: code, timedOut: false }); });
        });
        return classifyAuthStatus(run, this.opts.credentialSource);
    }

    private async diagnose(status: ClaudeAuthState['status']): Promise<DiagnosisResult> {
        const identity = keychainIdentityFor(this.env);
        const keychain = interpretSecurityRead(await this.security(securityReadArgs(identity)));
        const file = interpretCredentialsFile(this.readCredentialsFile(identity.credentialsPath));
        return diagnoseStores({ status, keychain, file });
    }

    private readCredentialsFile(path?: string): string | null {
        const target = path ?? keychainIdentityFor(this.env).credentialsPath;
        try {
            return existsSync(target) ? readFileSync(target, 'utf8') : null;
        } catch {
            return null;
        }
    }

    private security(args: string[]): Promise<SecurityResult> {
        return new Promise((resolve) => {
            execFile('security', args, { env: this.env, timeout: SECURITY_TIMEOUT_MS, maxBuffer: 65536 }, (error, stdout) => {
                const err = error as (NodeJS.ErrnoException & { code?: string | number; killed?: boolean }) | null;
                if (err && err.code === 'ENOENT') return resolve({ exitCode: null, stdout: '', error: 'ENOENT' });
                if (err && err.killed) return resolve({ exitCode: null, stdout: '', error: 'timeout' });
                const exitCode = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
                resolve({ exitCode, stdout: String(stdout ?? '') });
            });
        });
    }

    private async resolveLineage(): Promise<ClaudeAuthLineage> {
        if (this.lineage) return this.lineage;
        if (this.platform !== 'darwin') { this.lineage = 'other'; return this.lineage; }
        const uid = typeof process.getuid === 'function' ? process.getuid() : null;
        const launchdJobPid = uid === null ? null : parseLaunchctlPid(await this.exec('launchctl', ['print', `gui/${uid}/${HAPPY_DAEMON_LAUNCHD_LABEL}`]));
        const ancestors = await this.ancestorPids();
        this.lineage = classifyLineage({ platform: this.platform, env: this.env, launchdJobPid, ancestorPids: ancestors });
        return this.lineage;
    }

    private async ancestorPids(): Promise<number[]> {
        const out: number[] = [];
        let pid = process.ppid;
        for (let i = 0; i < 10 && pid > 1; i++) {
            out.push(pid);
            const ppid = Number((await this.exec('ps', ['-o', 'ppid=', '-p', String(pid)])).trim());
            if (!Number.isFinite(ppid) || ppid === pid) break;
            pid = ppid;
        }
        return out;
    }

    private exec(cmd: string, args: string[]): Promise<string> {
        return new Promise((resolve) => {
            execFile(cmd, args, { env: this.env, timeout: SECURITY_TIMEOUT_MS, maxBuffer: 65536 }, (_error, stdout) => resolve(String(stdout ?? '')));
        });
    }
}
