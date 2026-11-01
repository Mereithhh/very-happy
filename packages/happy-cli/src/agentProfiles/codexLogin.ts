/**
 * B-850b: Codex ChatGPT sign-in from the Web, and the account checks.
 *
 * Remote sign-in = `account/login/start {type:'chatgptDeviceCode'}` on a
 * `codex app-server` whose CODEX_HOME is the account's overlay (FEASIBILITY
 * C2): it returns `verificationUrl` + `userCode`, the user enters the code on
 * OpenAI's page, and Codex writes `auth.json` into that overlay and sends
 * `account/login/completed`. Nothing secret crosses the relay — the user code
 * is useless without the user's own browser sign-in.
 */
import { spawn as nodeSpawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { AgentProfileLoginStatus } from '@slopus/happy-wire';
import { CODEX_ALWAYS_STRIPPED_ENV_KEYS } from './codexAccount';
import { classifyHttpCheck, sanitizeDetail, CHECK_TIMEOUT_MS } from './checkAccount';
import type { AccountCheck } from './store';

/** OpenAI's device codes live 15 minutes. */
export const DEVICE_LOGIN_TIMEOUT_MS = 15 * 60_000;
export const DEVICE_LOGIN_START_TIMEOUT_MS = 20_000;
const LOGIN_RETAIN_MS = 10 * 60_000;

export type CodexRpc = {
    request: (method: string, params: unknown, timeoutMs?: number) => Promise<any>;
    onNotification: (cb: (method: string, params: any) => void) => void;
    onExit: (cb: (code: number | null) => void) => void;
    close: () => void;
};

export type SpawnCodexRpc = (codexHome: string, env: Record<string, string>) => CodexRpc;

/** Env for a sign-in / check app-server: its CODEX_HOME, no inherited OpenAI key steering it. */
export function codexLoginEnv(base: Record<string, string | undefined>, codexHome: string): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(base)) if (typeof v === 'string') env[k] = v;
    for (const key of CODEX_ALWAYS_STRIPPED_ENV_KEYS) delete env[key];
    env.CODEX_HOME = codexHome;
    env.RUST_LOG = 'warn';
    return env;
}

/** `codex app-server` over stdio (JSON-RPC lines), initialized. */
export const spawnCodexRpc: SpawnCodexRpc = (codexHome, env) => {
    const child = nodeSpawn('codex', ['app-server', '--listen', 'stdio://'], { env, cwd: codexHome, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
    const listeners: Array<(method: string, params: any) => void> = [];
    let nextId = 1;
    createInterface({ input: child.stdout! }).on('line', (line) => {
        let msg: any;
        try {
            msg = JSON.parse(line);
        } catch {
            return;
        }
        if (msg.id != null && pending.has(msg.id)) {
            const p = pending.get(msg.id)!;
            pending.delete(msg.id);
            if (msg.error) p.reject(new Error(msg.error.message ?? 'codex app-server error'));
            else p.resolve(msg.result);
        } else if (msg.method && msg.id == null) {
            for (const cb of listeners) cb(msg.method, msg.params);
        }
    });
    const send = (obj: unknown) => child.stdin?.writable && child.stdin.write(JSON.stringify(obj) + '\n');
    const request = (method: string, params: unknown, timeoutMs = 15_000) => new Promise<any>((resolve, reject) => {
        const id = nextId++;
        const timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error(`${method} timed out`));
        }, timeoutMs);
        pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
        send({ jsonrpc: '2.0', id, method, params });
    });
    child.on('error', () => { /* surfaced through onExit / request timeouts */ });
    const initialized = request('initialize', { clientInfo: { name: 'very-happy-accounts', version: '1' } }).then(() => send({ jsonrpc: '2.0', method: 'initialized' }));
    return {
        request: async (method, params, timeoutMs) => {
            await initialized;
            return request(method, params, timeoutMs);
        },
        onNotification: (cb) => { listeners.push(cb); },
        onExit: (cb) => { child.on('exit', (code) => cb(code)); },
        close: () => { child.kill(); },
    };
};

type DeviceLogin = {
    status: AgentProfileLoginStatus;
    rpc: CodexRpc | null;
    codexLoginId?: string;
    timers: ReturnType<typeof setTimeout>[];
};

export type DeviceLoginDeps = {
    spawnRpc: SpawnCodexRpc;
    env: Record<string, string | undefined>;
    newId: () => string;
    now?: () => number;
    /** Sign-in finished: persist the account (email / plan from `account/read`); returns its summary. */
    onSuccess: (loginId: string, account: { email?: string; planType?: string }) => Promise<NonNullable<AgentProfileLoginStatus['account']>>;
    onEnd?: (loginId: string, state: string) => void;
};

/** One Codex sign-in at a time per machine (independent of the Claude one). */
export class CodexDeviceLoginManager {
    private readonly logins = new Map<string, DeviceLogin>();
    private readonly now: () => number;

    constructor(private readonly deps: DeviceLoginDeps) {
        this.now = deps.now ?? Date.now;
    }

    activeLoginId(): string | null {
        for (const [id, e] of this.logins) if (e.status.state === 'starting' || e.status.state === 'waiting-code') return id;
        return null;
    }

    has(loginId: string): boolean {
        return this.logins.has(loginId);
    }

    async start(codexHome: string): Promise<AgentProfileLoginStatus> {
        const busy = this.activeLoginId();
        if (busy) throw Object.assign(new Error('another Codex sign-in is in progress'), { code: 'login-busy', loginId: busy });
        const loginId = this.deps.newId();
        const entry: DeviceLogin = { status: { loginId, state: 'starting', flow: 'device-code' }, rpc: null, timers: [] };
        this.logins.set(loginId, entry);
        let rpc: CodexRpc;
        try {
            rpc = this.deps.spawnRpc(codexHome, codexLoginEnv(this.deps.env, codexHome));
        } catch (error) {
            this.finish(entry, 'failed', `could not start codex: ${error instanceof Error ? error.message : String(error)}`);
            return { ...entry.status };
        }
        entry.rpc = rpc;
        rpc.onExit(() => {
            entry.rpc = null;
            if (entry.status.state === 'starting' || entry.status.state === 'waiting-code') this.finish(entry, 'failed', 'codex app-server exited');
        });
        rpc.onNotification((method, params) => {
            if (method !== 'account/login/completed') return;
            if (params?.loginId && entry.codexLoginId && params.loginId !== entry.codexLoginId) return;
            if (params?.success) void this.complete(entry);
            else this.finish(entry, 'failed', sanitizeDetail(String(params?.error ?? 'sign-in failed')));
        });
        try {
            const result = await rpc.request('account/login/start', { type: 'chatgptDeviceCode' }, DEVICE_LOGIN_START_TIMEOUT_MS);
            if (typeof result?.verificationUrl !== 'string' || typeof result?.userCode !== 'string') throw new Error('codex returned no device code');
            entry.codexLoginId = typeof result.loginId === 'string' ? result.loginId : undefined;
            if (entry.status.state === 'starting') {
                entry.status = { ...entry.status, state: 'waiting-code', url: result.verificationUrl, userCode: result.userCode, expiresAt: this.now() + DEVICE_LOGIN_TIMEOUT_MS };
                entry.timers.push(setTimeout(() => {
                    if (entry.status.state === 'waiting-code') this.finish(entry, 'expired');
                }, DEVICE_LOGIN_TIMEOUT_MS));
            }
        } catch (error) {
            this.finish(entry, 'failed', sanitizeDetail(error instanceof Error ? error.message : String(error)));
        }
        return { ...entry.status };
    }

    private async complete(entry: DeviceLogin): Promise<void> {
        if (entry.status.state !== 'waiting-code' && entry.status.state !== 'starting') return;
        let account: { email?: string; planType?: string } = {};
        try {
            const read = await entry.rpc?.request('account/read', { refreshToken: false });
            const a = read?.account;
            if (a?.type === 'chatgpt') account = { ...(a.email ? { email: String(a.email) } : {}), ...(a.planType ? { planType: String(a.planType) } : {}) };
        } catch {
            // email / plan are cosmetic; the sign-in itself succeeded.
        }
        try {
            const summary = await this.deps.onSuccess(entry.status.loginId, account);
            entry.status = { ...entry.status, account: summary };
            this.finish(entry, 'succeeded');
        } catch (error) {
            this.finish(entry, 'failed', error instanceof Error ? error.message : String(error));
        }
    }

    status(loginId: string): AgentProfileLoginStatus {
        return { ...this.get(loginId).status };
    }

    cancel(loginId: string): AgentProfileLoginStatus {
        const entry = this.get(loginId);
        if (entry.status.state === 'starting' || entry.status.state === 'waiting-code') {
            if (entry.codexLoginId) void entry.rpc?.request('account/login/cancel', { loginId: entry.codexLoginId }, 5_000).catch(() => {});
            this.finish(entry, 'canceled');
        }
        return { ...entry.status };
    }

    dispose(): void {
        for (const entry of this.logins.values()) {
            if (entry.status.state === 'starting' || entry.status.state === 'waiting-code') this.finish(entry, 'canceled');
            for (const t of entry.timers) clearTimeout(t);
        }
        this.logins.clear();
    }

    private get(loginId: string): DeviceLogin {
        const entry = this.logins.get(loginId);
        if (!entry) throw Object.assign(new Error(`no login "${loginId}"`), { code: 'login-not-found' });
        return entry;
    }

    private finish(entry: DeviceLogin, state: 'succeeded' | 'failed' | 'canceled' | 'expired', error?: string): void {
        entry.status = { ...entry.status, state, ...(error ? { error } : {}) };
        for (const t of entry.timers) clearTimeout(t);
        entry.timers = [];
        const rpc = entry.rpc;
        entry.rpc = null;
        // Give a cancel request a moment to reach Codex before the process goes.
        if (rpc) setTimeout(() => rpc.close(), state === 'canceled' ? 500 : 0).unref?.();
        this.deps.onEnd?.(entry.status.loginId, state);
        const t = setTimeout(() => this.logins.delete(entry.status.loginId), LOGIN_RETAIN_MS);
        t.unref?.();
    }
}

/** Pure: `account/read` result → check. */
export function classifyChatgptRead(read: unknown, now: number): AccountCheck {
    const account = (read as { account?: { type?: unknown } } | null)?.account;
    if (account && account.type === 'chatgpt') return { status: 'ok', at: now };
    return { status: 'expired', at: now, detail: 'not signed in' };
}

/** A ChatGPT account: `account/read` with a refresh in its own overlay (a dead refresh token → expired). */
export async function checkCodexChatgptAccount(codexHome: string, env: Record<string, string | undefined>, spawnRpc: SpawnCodexRpc = spawnCodexRpc, now: () => number = Date.now): Promise<AccountCheck> {
    let rpc: CodexRpc | null = null;
    try {
        rpc = spawnRpc(codexHome, codexLoginEnv(env, codexHome));
        const read = await rpc.request('account/read', { refreshToken: true }, CHECK_TIMEOUT_MS);
        return classifyChatgptRead(read, now());
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/refresh token|401|unauthori[sz]ed|sign in again|log in again/i.test(message)) return { status: 'expired', at: now(), detail: sanitizeDetail(message) };
        return { status: 'unverified', at: now(), detail: sanitizeDetail(message) };
    } finally {
        rpc?.close();
    }
}

/** An API provider: GET <baseUrl>/models with the key (no tokens spent). */
export async function checkCodexProviderAccount(baseUrl: string, key: string, headers: Record<string, string> = {}, now: () => number = Date.now): Promise<AccountCheck> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
    try {
        const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/models`, { signal: controller.signal, headers: { ...headers, authorization: `Bearer ${key}` } });
        const body = res.ok ? '' : (await res.text().catch(() => '')).slice(0, 300);
        return classifyHttpCheck('codex-provider', res.status, body, now());
    } catch (error) {
        return { status: 'unverified', at: now(), detail: sanitizeDetail(error instanceof Error ? error.message : String(error)) };
    } finally {
        clearTimeout(timer);
    }
}
