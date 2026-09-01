/**
 * B-276 — Claude auth preflight (spec specs/2026-09-claude-auth-preflight.md).
 *
 * Pure decision logic for "can the Claude Code binary that remote sessions will
 * spawn actually authenticate from THIS daemon process?" plus the darwin
 * keychain diagnoser. Every process/file interaction is injected so the whole
 * module is unit-testable without touching a real keychain.
 */
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { delimiter, join } from 'node:path';
import { keychainIdentity, type KeychainIdentity } from './keychainIdentity';

export const CLAUDE_AUTH_PROBE_VERSION = 1 as const;

export type ClaudeAuthStatus = 'ok' | 'not-logged-in' | 'unknown' | 'error' | 'claude-missing';
export type ClaudeAuthDiagnosis =
    | 'keychain-empty-item' | 'store-divergence' | 'no-credentials'
    | 'sdk-binary-missing' | 'probe-timeout' | 'probe-crash';
export type ClaudeAuthLineage = 'launchd' | 'inherited-env' | 'other';
export type ClaudeCredentialStore = 'auto' | 'file';

export interface ClaudeAuthState {
    probeVersion: typeof CLAUDE_AUTH_PROBE_VERSION;
    daemonPid: number;
    status: ClaudeAuthStatus;
    authMethod?: string;
    subscriptionType?: string;
    diagnosis?: ClaudeAuthDiagnosis;
    detail?: string;
    repairable?: 'delete-empty-keychain-item';
    context: { platform: string; lineage: ClaudeAuthLineage; credentialStore: ClaudeCredentialStore };
    checkedAt: number;
}

/** Local-credential sources for which `auth status` is authoritative. */
const LOCAL_CREDENTIAL_SOURCE = 'Claude local credentials';

export interface ProbeRun {
    stdout: string;
    exitCode: number | null;
    timedOut: boolean;
    spawnError?: string;
}

export interface AuthStatusClassification {
    status: ClaudeAuthStatus;
    authMethod?: string;
    subscriptionType?: string;
    diagnosis?: ClaudeAuthDiagnosis;
    detail?: string;
}

/** Parse `claude auth status` output. JSON first; exit code only as a fallback. */
export function classifyAuthStatus(run: ProbeRun, credentialSource: string | undefined): AuthStatusClassification {
    const localSource = credentialSource === undefined || credentialSource === LOCAL_CREDENTIAL_SOURCE;
    if (run.spawnError) {
        return { status: 'error', diagnosis: 'probe-crash', detail: `could not run claude auth status: ${run.spawnError}` };
    }
    if (run.timedOut) {
        return { status: 'error', diagnosis: 'probe-timeout', detail: 'claude auth status did not answer within the timeout' };
    }
    const parsed = parseJsonObject(run.stdout);
    if (!parsed) {
        if (!localSource) return { status: 'unknown', authMethod: credentialSource, detail: `auth status unparseable under ${credentialSource}` };
        return { status: 'error', diagnosis: 'probe-crash', detail: `claude auth status returned no JSON (exit ${run.exitCode ?? 'null'})` };
    }
    const authMethod = typeof parsed.authMethod === 'string' ? parsed.authMethod : undefined;
    const subscriptionType = typeof parsed.subscriptionType === 'string' ? parsed.subscriptionType : undefined;
    if (parsed.loggedIn === true) {
        return { status: 'ok', authMethod: localSource ? authMethod : credentialSource, subscriptionType };
    }
    if (!localSource) {
        return { status: 'unknown', authMethod: credentialSource, detail: `Claude Code reports loggedIn=false under ${credentialSource}; not a local-credential failure` };
    }
    return { status: 'not-logged-in', authMethod, subscriptionType, detail: 'Claude Code in the daemon context reports it is not logged in' };
}

function parseJsonObject(text: string): Record<string, unknown> | null {
    const trimmed = text.trim();
    if (!trimmed) return null;
    const start = trimmed.indexOf('{');
    if (start < 0) return null;
    try {
        const value = JSON.parse(trimmed.slice(start));
        return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
    } catch {
        return null;
    }
}

/**
 * The exact native binary the Agent SDK spawns (no PATH fallback — the SDK has
 * none either, and `getClaudeCliPath()` would `process.exit(1)` on a miss).
 */
export function resolveSdkClaudeBinary(
    platform: string = process.platform,
    arch: string = process.arch,
    resolver: (specifier: string) => string = (s) => createRequire(import.meta.url).resolve(s),
): string | null {
    const platformArch = `${platform}-${arch}`;
    const candidates = [
        `@anthropic-ai/claude-agent-sdk-${platformArch}/claude`,
        `@anthropic-ai/claude-agent-sdk-${platformArch}/claude.exe`,
    ];
    for (const candidate of candidates) {
        try {
            return resolver(candidate);
        } catch {
            // try next
        }
    }
    return null;
}

// ── keychain diagnoser (darwin) ─────────────────────────────────────────────

export interface SecurityResult { exitCode: number | null; stdout: string; error?: 'ENOENT' | 'timeout' | string }
export type SecurityRunner = (args: string[]) => Promise<SecurityResult>;

export type KeychainRead =
    | { kind: 'present'; accessToken: string; refreshToken: string; raw: string }
    | { kind: 'absent' }
    | { kind: 'unreadable' }
    | { kind: 'unsupported' }
    | { kind: 'error'; detail: string };

export function interpretSecurityRead(result: SecurityResult): KeychainRead {
    if (result.error === 'ENOENT') return { kind: 'unsupported' };
    if (result.error === 'timeout') return { kind: 'error', detail: 'security timed out' };
    if (result.exitCode === 44) return { kind: 'absent' };
    if (result.exitCode === 36) return { kind: 'unreadable' };
    if (result.exitCode !== 0) return { kind: 'error', detail: `security exited ${result.exitCode ?? 'null'}` };
    const raw = result.stdout.trim();
    if (!raw) return { kind: 'absent' };
    const parsed = parseJsonObject(raw);
    const oauth = parsed && typeof parsed.claudeAiOauth === 'object' && parsed.claudeAiOauth ? parsed.claudeAiOauth as Record<string, unknown> : null;
    if (!oauth) return { kind: 'present', accessToken: '', refreshToken: '', raw };
    return {
        kind: 'present',
        accessToken: typeof oauth.accessToken === 'string' ? oauth.accessToken : '',
        refreshToken: typeof oauth.refreshToken === 'string' ? oauth.refreshToken : '',
        raw,
    };
}

export interface FileCredentials { exists: boolean; hasTokens: boolean; refreshToken: string }

export function interpretCredentialsFile(text: string | null): FileCredentials {
    if (text === null) return { exists: false, hasTokens: false, refreshToken: '' };
    const parsed = parseJsonObject(text);
    const oauth = parsed && typeof parsed.claudeAiOauth === 'object' && parsed.claudeAiOauth ? parsed.claudeAiOauth as Record<string, unknown> : null;
    const access = oauth && typeof oauth.accessToken === 'string' ? oauth.accessToken : '';
    const refresh = oauth && typeof oauth.refreshToken === 'string' ? oauth.refreshToken : '';
    return { exists: true, hasTokens: access.length > 0 && refresh.length > 0, refreshToken: refresh };
}

export interface DiagnosisResult {
    diagnosis?: ClaudeAuthDiagnosis;
    detail?: string;
    repairable?: 'delete-empty-keychain-item';
    /** Raw keychain item observed (for the repair precondition re-check). Never logged. */
    keychainRaw?: string;
}

/** Never log or ship token material: compare by length + sha256 tail only. */
function tokenTail(token: string): string {
    return token ? createHash('sha256').update(token).digest('hex').slice(-6) : '';
}

export function diagnoseStores(input: {
    status: ClaudeAuthStatus;
    keychain: KeychainRead;
    file: FileCredentials;
}): DiagnosisResult {
    const { status, keychain, file } = input;
    if (keychain.kind === 'present') {
        const empty = keychain.accessToken.length === 0 && keychain.refreshToken.length === 0;
        if (empty && file.hasTokens && status === 'not-logged-in') {
            return {
                diagnosis: 'keychain-empty-item',
                repairable: 'delete-empty-keychain-item',
                keychainRaw: keychain.raw,
                detail: 'The login keychain holds a Claude Code credentials item with empty tokens; Claude Code prefers it over the valid ~/.claude/.credentials.json and reports not logged in.',
            };
        }
        if (!empty && file.hasTokens && tokenTail(keychain.refreshToken) !== tokenTail(file.refreshToken)) {
            return {
                diagnosis: 'store-divergence',
                detail: 'Keychain and ~/.claude/.credentials.json hold different refresh tokens; one of them will stop working at its next refresh. Treat the daemon-context login as canonical, or pin credentialStore=file.',
            };
        }
        return {};
    }
    if ((keychain.kind === 'absent' || keychain.kind === 'unreadable' || keychain.kind === 'unsupported') && !file.hasTokens) {
        return { diagnosis: 'no-credentials', detail: 'No Claude Code credentials found for this daemon context; log in with `claude` on this machine.' };
    }
    if (keychain.kind === 'unreadable' && file.hasTokens && status === 'not-logged-in') {
        return { detail: 'The daemon context cannot read the keychain and the file credentials were not accepted; compare `claude auth status` on the machine.' };
    }
    if (keychain.kind === 'error') {
        return { detail: `keychain check failed: ${keychain.detail}` };
    }
    return {};
}

export function securityReadArgs(identity: KeychainIdentity): string[] {
    return ['find-generic-password', '-s', identity.service, '-a', identity.account, '-w'];
}

export function securityDeleteArgs(identity: KeychainIdentity): string[] {
    return ['delete-generic-password', '-s', identity.service, '-a', identity.account];
}

// ── lineage ─────────────────────────────────────────────────────────────────

export const HAPPY_DAEMON_LAUNCHD_LABEL = 'com.mereith.happy-daemon';

export function classifyLineage(input: {
    platform: string;
    env: NodeJS.ProcessEnv;
    launchdJobPid: number | null;
    ancestorPids: number[];
    label?: string;
}): ClaudeAuthLineage {
    if (input.platform !== 'darwin') return 'other';
    const label = input.label ?? HAPPY_DAEMON_LAUNCHD_LABEL;
    if (input.env.XPC_SERVICE_NAME !== label) return 'other';
    if (input.launchdJobPid !== null && input.ancestorPids.includes(input.launchdJobPid)) return 'launchd';
    return 'inherited-env';
}

export function parseLaunchctlPid(printOutput: string): number | null {
    const match = /^\s*pid\s*=\s*(\d+)/m.exec(printOutput);
    return match ? Number(match[1]) : null;
}

// ── D8 credential store pinning ─────────────────────────────────────────────

export function keychainOffShimDir(happyLibDir: string): string {
    return join(happyLibDir, 'scripts', 'shims', 'keychain-off');
}

/** PATH for a Claude Code process under `credentialStore=file`. */
export function withKeychainOffPath(path: string | undefined, shimDir: string): string {
    const parts = (path ?? '').split(delimiter).filter((p) => p && p !== shimDir);
    return [shimDir, ...parts].join(delimiter);
}

// ── assembly ────────────────────────────────────────────────────────────────

export function buildClaudeAuthState(input: {
    daemonPid: number;
    platform: string;
    lineage: ClaudeAuthLineage;
    credentialStore: ClaudeCredentialStore;
    classification: AuthStatusClassification;
    diagnosis?: DiagnosisResult;
    now?: number;
}): ClaudeAuthState {
    const { classification, diagnosis } = input;
    const detail = (diagnosis?.detail ?? classification.detail)?.slice(0, 200);
    const state: ClaudeAuthState = {
        probeVersion: CLAUDE_AUTH_PROBE_VERSION,
        daemonPid: input.daemonPid,
        status: classification.status,
        context: { platform: input.platform, lineage: input.lineage, credentialStore: input.credentialStore },
        checkedAt: input.now ?? Date.now(),
    };
    if (classification.authMethod) state.authMethod = classification.authMethod;
    if (classification.subscriptionType) state.subscriptionType = classification.subscriptionType;
    const diag = diagnosis?.diagnosis ?? classification.diagnosis;
    if (diag) state.diagnosis = diag;
    if (detail) state.detail = detail;
    if (diagnosis?.repairable) state.repairable = diagnosis.repairable;
    return state;
}

/** Equality that ignores `checkedAt` (the 10-minute probe must not churn daemonState). */
export function claudeAuthStateChanged(prev: ClaudeAuthState | null | undefined, next: ClaudeAuthState): boolean {
    if (!prev) return true;
    const strip = ({ checkedAt: _c, ...rest }: ClaudeAuthState) => JSON.stringify(rest);
    return strip(prev) !== strip(next);
}

export function keychainIdentityFor(env: NodeJS.ProcessEnv): KeychainIdentity {
    return keychainIdentity(env);
}
