/**
 * B-883b: an account or provider that does not serve 1M context.
 *
 * Follow-latest sends `claude-opus-5-5[1m]` by default (B-883). Claude Code
 * turns `[1m]` into the `context-1m-…` beta header. Measured against Claude
 * Code 2.1.304 with a stub provider (tmp/vh-team-B-883b, 2026-11-03):
 *  - 400 naming the beta (`long context beta` / the header / "invalid beta
 *    flag"): Claude Code resends once without it and the turn succeeds — no
 *    help needed;
 *  - 429 "Extra usage is required for long context requests" (the Anthropic
 *    subscription shape; Claude Code has its own copy of the text): the turn
 *    fails at once with a root synthetic reply, `error: 'rate_limit'`,
 *    `api_error_status: 429`;
 *  - 403: Claude Code retries 10 times (~3 min) and then fails the same way.
 * Every failed turn left the session unusable on follow-latest: the next
 * message asks for `[1m]` again.
 *
 * What the wrapper does about it: a rejection while running a `[1m]` id that
 * the session got from following latest is retried once on the plain id with
 * a notice, and the machine remembers (per provider + Claude config dir) that
 * 1M is not served, so later sessions follow latest without `[1m]`. A `[1m]`
 * the user picked is never downgraded — the turn fails with a clear notice.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { LATEST_MODEL_MODE, LONG_CONTEXT_MARKER, type LongContextUnsupported } from '@slopus/happy-wire';

const LONG_CONTEXT_ERROR_TEXT = /long[ -]context|context-1m|\b1m context\b/i;
const REJECTION_STATUSES = new Set([400, 403, 429]);

export type LongContextRejection = { model: string; plain: string; reason: string };

function rootErrorText(message: { message?: unknown }): string {
    const content = (message.message as { content?: unknown } | undefined)?.content;
    if (!Array.isArray(content)) return '';
    return content.map((block) => (block && typeof block === 'object' && typeof (block as { text?: unknown }).text === 'string' ? (block as { text: string }).text : '')).join(' ');
}

/**
 * The running `[1m]` model when this frame is Claude Code's synthetic reply to
 * a request the provider refused for its long context (root reply only).
 */
export function longContextRejectionFrom(message: unknown, runningModel: string | null | undefined): LongContextRejection | null {
    const m = message as { type?: unknown; error?: unknown; parent_tool_use_id?: unknown; is_api_error_message?: unknown; api_error_status?: unknown; message?: unknown } | null;
    if (!m || m.type !== 'assistant' || !m.error) return null;
    if ((m.parent_tool_use_id ?? null) !== null) return null;
    if (typeof runningModel !== 'string' || !runningModel.endsWith(LONG_CONTEXT_MARKER)) return null;
    const status = typeof m.api_error_status === 'number' ? m.api_error_status : null;
    if (status !== null && !REJECTION_STATUSES.has(status)) return null;
    const text = rootErrorText(m);
    if (!LONG_CONTEXT_ERROR_TEXT.test(text)) return null;
    return { model: runningModel, plain: runningModel.slice(0, -LONG_CONTEXT_MARKER.length), reason: text.trim().slice(0, 300) };
}

/** What to do with a rejection; `retry` only for a `[1m]` that came from following latest. */
export type LongContextDecision = 'retry' | 'fail';

export type LongContextPolicy = {
    /** Called once per rejected turn; records the machine verdict and says whether to retry on the plain id. */
    onRejected(rejection: LongContextRejection): LongContextDecision;
};

export function longContextFallbackNotice(rejection: LongContextRejection): string {
    return `⚠️ This account or provider does not support 1M context — retried with ${rejection.plain} (standard context). `
        + `Following latest no longer uses 1M on this machine.\n`
        + `⚠️ 当前账号或供应商不支持 1M 上下文，已改用 ${rejection.plain}（标准上下文）重试。此后这台机器跟随最新不再使用 1M。`;
}

export function longContextExplicitNotice(rejection: LongContextRejection): string {
    return `⚠️ ${rejection.model} was rejected: this account or provider does not support 1M context. `
        + `Turn off 1M context in the model picker (or pick another model) and send again.\n`
        + `⚠️ ${rejection.model} 被拒绝：当前账号或供应商不支持 1M 上下文。请在模型选择器里关闭 1M 上下文（或换一个模型）后重新发送。`;
}

/**
 * Machine-level memory. Keyed by where requests go (`ANTHROPIC_BASE_URL`) and
 * whose login sends them (`CLAUDE_CONFIG_DIR`): another provider or account
 * on the same machine is not judged by this one's verdict.
 */
export function longContextKey(env: Record<string, string | undefined>, settingsEnv: Record<string, unknown> = {}): string {
    // settings.json `env` wins over the process env inside Claude Code.
    const base = typeof settingsEnv.ANTHROPIC_BASE_URL === 'string' && settingsEnv.ANTHROPIC_BASE_URL.trim()
        ? settingsEnv.ANTHROPIC_BASE_URL.trim()
        : env.ANTHROPIC_BASE_URL?.trim() || 'anthropic';
    return `${base}|${env.CLAUDE_CONFIG_DIR?.trim() || '~/.claude'}`;
}

export function longContextStorePath(happyHomeDir: string): string {
    return join(happyHomeDir, 'claude-long-context.json');
}

type StoreFile = { unsupported?: Record<string, LongContextUnsupported> };

function readStore(path: string): StoreFile {
    try {
        const parsed = JSON.parse(readFileSync(path, 'utf8'));
        return parsed && typeof parsed === 'object' ? parsed as StoreFile : {};
    } catch {
        return {};
    }
}

export function readLongContextVerdict(path: string, key: string): LongContextUnsupported | null {
    const entry = readStore(path).unsupported?.[key];
    return entry && typeof entry.reason === 'string' && typeof entry.at === 'number' ? entry : null;
}

export function writeLongContextVerdict(path: string, key: string, verdict: LongContextUnsupported): void {
    const store = readStore(path);
    store.unsupported = { ...store.unsupported, [key]: verdict };
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(store, null, 2));
    renameSync(tmp, path);
}

type PolicySession = {
    getMetadata(): { modelIntent?: string | null; stickyModel?: string | null; longContextUnsupported?: LongContextUnsupported | null } | null;
    updateMetadata(handler: (metadata: any) => any): void;
};

/**
 * The wrapper's policy: every refusal is remembered (store + metadata, so the
 * Web picker and later sessions follow latest without `[1m]`); only a session
 * whose recorded intent is `latest` retries on the plain id.
 */
export function createLongContextPolicy(input: {
    session: PolicySession;
    storePath: string;
    key: string;
    now?: () => number;
    write?: typeof writeLongContextVerdict;
}): LongContextPolicy {
    const write = input.write ?? writeLongContextVerdict;
    return {
        onRejected(rejection) {
            const verdict: LongContextUnsupported = { reason: rejection.reason, at: (input.now ?? Date.now)() };
            try {
                write(input.storePath, input.key, verdict);
            } catch {
                // Memory is best effort; this session still records it below.
            }
            const retry = input.session.getMetadata()?.modelIntent === LATEST_MODEL_MODE;
            // Following latest, the session now keeps the plain id (a resume restores stickyModel).
            input.session.updateMetadata((metadata) => ({
                ...metadata,
                longContextUnsupported: verdict,
                ...(retry && metadata.stickyModel === rejection.model ? { stickyModel: rejection.plain } : {}),
            }));
            return retry ? 'retry' : 'fail';
        },
    };
}

/**
 * A message that follows latest but still asks for `[1m]` (an older Web, or one
 * that has not seen the verdict yet) runs on the plain id once the machine is
 * known not to serve 1M. An explicit `[1m]` pick is left alone.
 */
export function withoutRefusedLongContext(model: string | undefined, modelIntent: unknown, verdict: LongContextUnsupported | null | undefined): string | undefined {
    if (!verdict || modelIntent !== LATEST_MODEL_MODE || !model?.endsWith(LONG_CONTEXT_MARKER)) return model;
    return model.slice(0, -LONG_CONTEXT_MARKER.length);
}
