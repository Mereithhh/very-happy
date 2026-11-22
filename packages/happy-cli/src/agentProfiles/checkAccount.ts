/**
 * B-850a: "is this account usable right now" — one tiny real request.
 *
 *   claude-api          → POST <baseUrl>/v1/messages, 1 token, the account's first model
 *   claude-subscription → `claude -p` with the token injected exactly as a
 *                         session would (CLAUDE_CODE_OAUTH_TOKEN), hooks off,
 *                         no MCP, no transcript written
 *
 * 401/403 is definite (subscription → expired, API → invalid); anything else
 * that is not a success (network, 5xx, unknown model) stays `unverified` with
 * the reason, so a flaky check never blocks a session.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AccountCheck, AccountRecord } from './store';
import { ACCOUNT_STRIPPED_ENV_KEYS } from './claudeAccountEnv';

export const CHECK_TIMEOUT_MS = 20_000;
const DEFAULT_CHECK_MODEL = 'claude-haiku-4-5';

/** Pure: an HTTP outcome → check. */
export function classifyHttpCheck(kind: AccountRecord['kind'], status: number, bodySnippet: string, now: number): AccountCheck {
    if (status >= 200 && status < 300) return { status: 'ok', at: now };
    if (status === 401 || status === 403) {
        return { status: kind === 'claude-subscription' ? 'expired' : 'invalid', at: now, detail: `HTTP ${status}` };
    }
    return { status: 'unverified', at: now, detail: `HTTP ${status}${bodySnippet ? `: ${sanitizeDetail(bodySnippet)}` : ''}` };
}

/** Pure: `claude -p` outcome → check. */
export function classifyClaudeCheck(exitCode: number | null, output: string, now: number): AccountCheck {
    if (exitCode === 0) return { status: 'ok', at: now };
    if (/\b401\b|OAuth access token is invalid|invalid.*token|token.*(expired|revoked)/i.test(output)) {
        return { status: 'expired', at: now, detail: sanitizeDetail(lastLine(output)) };
    }
    return { status: 'unverified', at: now, detail: sanitizeDetail(lastLine(output) || `exit ${exitCode}`) };
}

function lastLine(text: string): string {
    return text.trim().split('\n').filter(Boolean).pop() ?? '';
}

/** Never echo anything token-shaped back to the Web. */
export function sanitizeDetail(text: string): string {
    return text.replace(/sk-ant-[A-Za-z0-9_-]+/g, 'sk-ant-…').replace(/\b(sk|rk)-[A-Za-z0-9_-]{16,}/g, '$1-…').replace(/\s+/g, ' ').trim().slice(0, 200);
}

export async function checkApiAccount(record: AccountRecord, key: string, now: () => number = Date.now): Promise<AccountCheck> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
    try {
        const res = await fetch(`${record.baseUrl}/v1/messages`, {
            method: 'POST',
            signal: controller.signal,
            headers: {
                'content-type': 'application/json',
                'anthropic-version': '2023-06-01',
                'x-api-key': key,
                authorization: `Bearer ${key}`,
            },
            body: JSON.stringify({
                model: record.models?.[0] ?? DEFAULT_CHECK_MODEL,
                max_tokens: 1,
                messages: [{ role: 'user', content: 'ping' }],
            }),
        });
        const text = res.ok ? '' : (await res.text().catch(() => '')).slice(0, 400);
        return classifyHttpCheck(record.kind, res.status, text, now());
    } catch (error) {
        return { status: 'unverified', at: now(), detail: sanitizeDetail(error instanceof Error ? error.message : String(error)) };
    } finally {
        clearTimeout(timer);
    }
}

export async function checkSubscriptionAccount(token: string, scratchDir: string, now: () => number = Date.now): Promise<AccountCheck> {
    mkdirSync(scratchDir, { recursive: true });
    const settingsPath = join(scratchDir, 'check-settings.json');
    writeFileSync(settingsPath, JSON.stringify({ disableAllHooks: true }));
    const env: Record<string, string | undefined> = { ...process.env };
    for (const key of ACCOUNT_STRIPPED_ENV_KEYS) delete env[key];
    env.CLAUDE_CODE_OAUTH_TOKEN = token;
    return new Promise((resolve) => {
        let output = '';
        const child = spawn('claude', ['-p', 'ping', '--model', 'haiku', '--no-session-persistence', '--strict-mcp-config', '--settings', settingsPath], {
            cwd: scratchDir,
            env,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        const timer = setTimeout(() => child.kill('SIGKILL'), CHECK_TIMEOUT_MS);
        child.stdout.on('data', (d) => { output += d; });
        child.stderr.on('data', (d) => { output += d; });
        child.on('error', (error) => {
            clearTimeout(timer);
            resolve({ status: 'unverified', at: now(), detail: sanitizeDetail(error.message) });
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            resolve(classifyClaudeCheck(code, output.slice(-2000), now()));
        });
    });
}

/** B-952: DeepSeek's model list — free, no tokens; dsh asks the same endpoint at start. */
export const DSH_CHECK_URL = 'https://api.deepseek.com/models';

/**
 * B-957: the Messages API root dsh uses for a Base URL — dsh appends `/v1`
 * unless the URL already ends with it, then POSTs `<root>/messages`.
 */
export function dshMessagesRoot(baseUrl: string): string {
    const trimmed = baseUrl.replace(/\/+$/, '');
    return /\/v1$/.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

/** The model a gateway is asked for when it has no model list (1 token). dsh's default model. */
export const DSH_GATEWAY_CHECK_MODEL = 'deepseek-v4-flash';

/**
 * B-957 pure: a gateway's answer → check. 401/403 = the key; 404/405 or a 2xx
 * that is not an API answer (an HTML page) = the address (`reason: 'unreachable'`).
 */
export function classifyDshGatewayCheck(status: number, isApiAnswer: boolean, bodySnippet: string, now: number): AccountCheck {
    if (status >= 200 && status < 300) {
        return isApiAnswer ? { status: 'ok', at: now } : { status: 'unverified', at: now, reason: 'unreachable', detail: `HTTP ${status}, not an API response` };
    }
    if (status === 404 || status === 405) return { status: 'unverified', at: now, reason: 'unreachable', detail: `HTTP ${status}` };
    return classifyHttpCheck('dsh-api', status, bodySnippet, now);
}

type FetchResult = { status: number; json: unknown; text: string };

async function fetchJson(fetchImpl: typeof fetch, url: string, init: RequestInit): Promise<FetchResult> {
    const res = await fetchImpl(url, init);
    // Parse the whole body: a gateway's model list easily runs to tens of KB (a cut one is not JSON).
    const text = (await res.text().catch(() => '')).slice(0, 4_000_000);
    let json: unknown;
    try { json = JSON.parse(text); } catch { json = undefined; }
    return { status: res.status, json, text: res.ok ? '' : text.slice(0, 400) };
}

/**
 * B-952 dsh-api: `GET /models` with the key (401 → invalid, network → unverified).
 * B-957 with a Base URL: the gateway instead — `GET <root>/models` (free; a JSON
 * model list = ok), and only when the gateway has no such route (404/405) one
 * 1-token `POST <root>/messages`. A connection error is `reason: 'unreachable'`.
 */
export async function checkDshAccount(key: string, now: () => number = Date.now, fetchImpl: typeof fetch = fetch, baseUrl?: string): Promise<AccountCheck> {
    const check = await checkDshAccountRaw(key, now, fetchImpl, baseUrl);
    // A gateway may echo the key in any shape (not only sk-…): never pass it on.
    return check.detail && key && check.detail.includes(key) ? { ...check, detail: check.detail.split(key).join('…') } : check;
}

async function checkDshAccountRaw(key: string, now: () => number, fetchImpl: typeof fetch, baseUrl?: string): Promise<AccountCheck> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
    try {
        if (!baseUrl) {
            const res = await fetchImpl(DSH_CHECK_URL, { method: 'GET', signal: controller.signal, headers: { authorization: `Bearer ${key}` } });
            const text = res.ok ? '' : (await res.text().catch(() => '')).slice(0, 400);
            return classifyHttpCheck('dsh-api', res.status, text, now());
        }
        const root = dshMessagesRoot(baseUrl);
        const headers = { authorization: `Bearer ${key}`, 'x-api-key': key, 'anthropic-version': '2023-06-01' };
        const models = await fetchJson(fetchImpl, `${root}/models`, { method: 'GET', signal: controller.signal, headers });
        if (models.status !== 404 && models.status !== 405) {
            const listed = !!models.json && typeof models.json === 'object' && Array.isArray((models.json as { data?: unknown }).data);
            return classifyDshGatewayCheck(models.status, listed, models.text, now());
        }
        const ping = await fetchJson(fetchImpl, `${root}/messages`, {
            method: 'POST',
            signal: controller.signal,
            headers: { ...headers, 'content-type': 'application/json' },
            body: JSON.stringify({ model: DSH_GATEWAY_CHECK_MODEL, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }),
        });
        const answered = !!ping.json && typeof ping.json === 'object' && (ping.json as { type?: unknown }).type === 'message';
        return classifyDshGatewayCheck(ping.status, answered, ping.text, now());
    } catch (error) {
        const detail = sanitizeDetail(error instanceof Error ? errorWithCause(error) : String(error));
        return { status: 'unverified', at: now(), detail, ...(baseUrl ? { reason: 'unreachable' } : {}) };
    } finally {
        clearTimeout(timer);
    }
}

/** `fetch failed` alone says nothing; Node puts ENOTFOUND / ECONNREFUSED in `cause`. */
function errorWithCause(error: Error): string {
    const cause = (error as { cause?: unknown }).cause;
    const code = cause && typeof cause === 'object' ? (cause as { code?: unknown }).code : undefined;
    if (error.name === 'AbortError') return 'timed out';
    return typeof code === 'string' ? `${error.message} (${code})` : error.message;
}
