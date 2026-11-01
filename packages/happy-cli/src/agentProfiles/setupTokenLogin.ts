/**
 * B-850a: remote Claude subscription login = `claude setup-token` in a pty on
 * the machine. Its Ink UI only renders in a TTY (FEASIBILITY L2).
 *
 *   start  → spawn, wait for the authorize URL (the user picks the org there)
 *   submit → write the pasted code + Enter; the PKCE verifier never leaves
 *            this process, so the code alone cannot be redeemed elsewhere
 *   done   → `sk-ant-oat01-…` appears in the output → caller stores it 0600
 *
 * The token is matched in the pty output and handed to `onToken`; it is never
 * logged and never part of a status object.
 */
import type { AgentProfileLoginStatus } from '@slopus/happy-wire';
import { ACCOUNT_STRIPPED_ENV_KEYS } from './claudeAccountEnv';

export const LOGIN_CODE_TIMEOUT_MS = 10 * 60_000;
export const LOGIN_URL_TIMEOUT_MS = 20_000;
export const LOGIN_EXCHANGE_TIMEOUT_MS = 60_000;
export const LOGIN_RETAIN_MS = 10 * 60_000;

export type PtyLike = {
    onData: (cb: (data: string) => void) => void;
    onExit: (cb: (e: { exitCode: number }) => void) => void;
    write: (data: string) => void;
    kill: () => void;
};
export type SpawnPty = (env: Record<string, string>) => PtyLike;

/** Pure: strip ANSI / OSC so URL and token match across Ink redraws. */
export function stripAnsi(text: string): string {
    return text
        .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
        .replace(/\x1b\[[0-9;?<>=]*[ -/]*[@-~]/g, ' ')
        .replace(/\x1b[()][A-Za-z0-9]/g, '')
        .replace(/\x1b[=>78]/g, '');
}

export function findAuthorizeUrl(clean: string): string | null {
    const m = clean.match(/https:\/\/[^\s]*\/oauth\/authorize\?[^\s]+/);
    return m ? m[0] : null;
}

export function findSetupToken(clean: string): string | null {
    const m = clean.match(/sk-ant-oat01-[A-Za-z0-9_-]{20,}/);
    return m ? m[0] : null;
}

/** Pure: Ink's failure line after a bad code ("OAuth error: … 400  Press Enter to retry."). */
export function findLoginError(clean: string): string | null {
    const m = clean.match(/(OAuth error:[^\n]*?)(?:\s{2,}|Press|$)/) ?? clean.match(/(Login failed[^\n]*)/);
    return m ? m[1].replace(/\s+/g, ' ').trim().slice(0, 200) : null;
}

/** Env for the pty: no inherited credential may steer it, no browser on the daemon host. */
export function setupTokenEnv(base: Record<string, string | undefined>): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(base)) if (typeof v === 'string') env[k] = v;
    for (const key of ACCOUNT_STRIPPED_ENV_KEYS) delete env[key];
    env.BROWSER = 'true';
    env.TERM = 'xterm-256color';
    return env;
}

type LoginEntry = {
    status: AgentProfileLoginStatus;
    pty: PtyLike | null;
    output: string;
    timers: ReturnType<typeof setTimeout>[];
    /** The token was printed and is being stored: setup-token exiting now is success, not failure. */
    tokenSeen?: boolean;
    resolveUrl?: () => void;
};

export type LoginManagerDeps = {
    spawnPty: SpawnPty;
    env: Record<string, string | undefined>;
    /** Persist the token as an account; returns its summary for the status. */
    onToken: (loginId: string, token: string) => Promise<NonNullable<AgentProfileLoginStatus['account']>>;
    newId: () => string;
    now?: () => number;
};

export class SetupTokenLoginManager {
    private readonly logins = new Map<string, LoginEntry>();
    private readonly now: () => number;

    constructor(private readonly deps: LoginManagerDeps) {
        this.now = deps.now ?? Date.now;
    }

    /** One login at a time per machine: a second start cancels nothing and is refused. */
    activeLoginId(): string | null {
        for (const [id, e] of this.logins) if (e.status.state === 'waiting-code' || e.status.state === 'exchanging') return id;
        return null;
    }

    async start(): Promise<AgentProfileLoginStatus> {
        const busy = this.activeLoginId();
        if (busy) throw Object.assign(new Error('another login is in progress'), { code: 'login-busy', loginId: busy });
        const loginId = this.deps.newId();
        const entry: LoginEntry = {
            status: { loginId, state: 'starting' },
            pty: null,
            output: '',
            timers: [],
        };
        this.logins.set(loginId, entry);
        const urlReady = new Promise<void>((resolve) => { entry.resolveUrl = resolve; });
        try {
            entry.pty = this.deps.spawnPty(setupTokenEnv(this.deps.env));
        } catch (error) {
            this.finish(entry, 'failed', `could not start claude setup-token: ${error instanceof Error ? error.message : String(error)}`);
            return { ...entry.status };
        }
        entry.pty.onData((data) => this.onData(entry, data));
        entry.pty.onExit(({ exitCode }) => {
            entry.pty = null;
            if (entry.tokenSeen) return;
            if (entry.status.state === 'starting' || entry.status.state === 'waiting-code' || entry.status.state === 'exchanging') {
                this.finish(entry, 'failed', findLoginError(stripAnsi(entry.output)) ?? `claude setup-token exited (${exitCode})`);
            }
        });
        entry.timers.push(setTimeout(() => {
            if (entry.status.state === 'starting') this.finish(entry, 'failed', 'claude setup-token printed no sign-in URL');
        }, LOGIN_URL_TIMEOUT_MS));
        await Promise.race([urlReady, new Promise<void>((r) => entry.timers.push(setTimeout(r, LOGIN_URL_TIMEOUT_MS + 50)))]);
        return { ...entry.status };
    }

    submit(loginId: string, code: string): AgentProfileLoginStatus {
        const entry = this.get(loginId);
        if (entry.status.state !== 'waiting-code' || !entry.pty) return { ...entry.status };
        entry.status = { ...entry.status, state: 'exchanging' };
        // Drop what was printed so far: a retry prompt from an earlier attempt must not read as this one's verdict.
        entry.output = '';
        entry.pty.write(code.trim().replace(/[\r\n]/g, '') + '\r');
        entry.timers.push(setTimeout(() => {
            if (entry.status.state === 'exchanging' && !entry.tokenSeen) this.finish(entry, 'failed', 'timed out waiting for Claude to issue the token');
        }, LOGIN_EXCHANGE_TIMEOUT_MS));
        return { ...entry.status };
    }

    status(loginId: string): AgentProfileLoginStatus {
        return { ...this.get(loginId).status };
    }

    cancel(loginId: string): AgentProfileLoginStatus {
        const entry = this.get(loginId);
        if (entry.status.state === 'starting' || entry.status.state === 'waiting-code' || entry.status.state === 'exchanging') {
            this.finish(entry, 'canceled');
        }
        return { ...entry.status };
    }

    dispose(): void {
        for (const entry of this.logins.values()) this.finish(entry, entry.status.state === 'succeeded' ? 'succeeded' : 'canceled');
        this.logins.clear();
    }

    private get(loginId: string): LoginEntry {
        const entry = this.logins.get(loginId);
        if (!entry) throw Object.assign(new Error('unknown or expired login'), { code: 'login-not-found' });
        return entry;
    }

    private onData(entry: LoginEntry, data: string): void {
        entry.output = (entry.output + data).slice(-64_000);
        const clean = stripAnsi(entry.output);
        if (entry.status.state === 'starting') {
            const url = findAuthorizeUrl(clean);
            if (url) {
                const expiresAt = this.now() + LOGIN_CODE_TIMEOUT_MS;
                entry.status = { ...entry.status, state: 'waiting-code', url, expiresAt };
                entry.timers.push(setTimeout(() => {
                    if (entry.status.state === 'waiting-code') this.finish(entry, 'expired');
                }, LOGIN_CODE_TIMEOUT_MS));
                entry.resolveUrl?.();
            }
            return;
        }
        if (entry.status.state !== 'exchanging' || entry.tokenSeen) return;
        const token = findSetupToken(clean);
        if (token) {
            entry.tokenSeen = true;
            entry.output = '';
            this.deps.onToken(entry.status.loginId, token).then(
                (account) => this.finish(entry, 'succeeded', undefined, account),
                (error) => this.finish(entry, 'failed', error instanceof Error ? error.message : String(error)),
            );
            return;
        }
        const error = findLoginError(clean);
        // A rejected code leaves setup-token on "Press Enter to retry"; one
        // code per login keeps the state machine simple — start again.
        if (error) this.finish(entry, 'failed', error);
    }

    private finish(entry: LoginEntry, state: string, error?: string, account?: AgentProfileLoginStatus['account']): void {
        for (const t of entry.timers) clearTimeout(t);
        entry.timers = [];
        const { loginId, url, expiresAt } = entry.status;
        entry.status = { loginId, state, ...(url && state !== 'succeeded' ? { url } : {}), ...(expiresAt ? { expiresAt } : {}), ...(account ? { account } : {}), ...(error ? { error } : {}) };
        entry.resolveUrl?.();
        const pty = entry.pty;
        entry.pty = null;
        try { pty?.kill(); } catch { /* already gone */ }
        entry.output = '';
        const loginId_ = loginId;
        const t = setTimeout(() => this.logins.delete(loginId_), LOGIN_RETAIN_MS);
        t.unref?.();
    }
}
