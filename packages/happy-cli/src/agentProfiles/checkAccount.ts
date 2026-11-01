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
    return text.replace(/sk-ant-[A-Za-z0-9_-]+/g, 'sk-ant-…').replace(/\s+/g, ' ').trim().slice(0, 200);
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
