/**
 * B-026: retrying webhook delivery + per-account delivery counters.
 *
 * `sendWebhook` makes one attempt (5 s timeout). A receiver blip (Tanka
 * gateway restart, 502 from its proxy, a reset connection) used to lose the
 * notification for good. Delivery now retries in-process with exponential
 * backoff — only failures that can heal on their own:
 *   - no HTTP status at all (timeout, reset, refused, DNS lookup error);
 *   - 408 / 425 / 429 / 5xx.
 * Never retried: any other 4xx or 3xx (the receiver answered), and the SSRF
 * guard's verdicts (invalid URL, non-public address) — retrying those cannot
 * change the answer and would only hammer a rejected target.
 *
 * Every attempt of one notification carries the same `X-Very-Happy-Delivery`
 * id, so a receiver that did process a request whose response timed out can
 * drop the duplicate.
 *
 * Counters are in-memory per server process (no table, no migration): they
 * answer "is my webhook failing right now?" on the diagnostics page, and say
 * since when they count. A deploy resets them.
 */
import { randomUUID } from 'node:crypto';
import { log } from '@/utils/log';
import { sendWebhook, type WebhookPayload, type WebhookSendResult } from './webhookNotify';

/** Waits before retry 1, 2, 3 (±20% jitter): covers a ~45 s receiver outage. */
export const WEBHOOK_RETRY_DELAYS_MS: readonly number[] = [2_000, 8_000, 32_000];
const JITTER = 0.2;

/** Errors produced by the URL/SSRF guard: deterministic, never retried. */
const PERMANENT_ERRORS = [/^invalid url:/, /non-public address/, /response too large/];

export function isRetryableWebhookFailure(res: WebhookSendResult): boolean {
    if (res.ok) return false;
    if (typeof res.status === 'number' && res.status > 0) {
        return res.status === 408 || res.status === 425 || res.status === 429 || res.status >= 500;
    }
    const error = res.error ?? '';
    return !PERMANENT_ERRORS.some((re) => re.test(error));
}

export interface WebhookDeliveryResult extends WebhookSendResult {
    attempts: number;
    deliveryId: string;
}

export type WebhookAttempt = (url: string, payload: WebhookPayload, deliveryId: string) => Promise<WebhookSendResult>;

export async function deliverWebhook(
    url: string,
    payload: WebhookPayload,
    deps: {
        send: WebhookAttempt;
        sleep?: (ms: number) => Promise<void>;
        random?: () => number;
        delays?: readonly number[];
        deliveryId?: string;
        /** First attempt already made by the caller (inline), whose result is this. */
        firstResult?: WebhookSendResult;
    },
): Promise<WebhookDeliveryResult> {
    const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const random = deps.random ?? Math.random;
    const delays = deps.delays ?? WEBHOOK_RETRY_DELAYS_MS;
    const deliveryId = deps.deliveryId ?? randomUUID();
    let attempts = 1;
    let res = deps.firstResult ?? await deps.send(url, payload, deliveryId);
    for (const delay of delays) {
        if (!isRetryableWebhookFailure(res)) break;
        await sleep(Math.round(delay * (1 - JITTER + 2 * JITTER * random())));
        attempts++;
        res = await deps.send(url, payload, deliveryId);
    }
    return { ...res, attempts, deliveryId };
}

//
// Per-account counters
//

export interface WebhookDeliveryStats {
    /** epoch ms the counters started (server process start) */
    since: number;
    /** notifications that reached the receiver (2xx), possibly after retries */
    delivered: number;
    /** notifications given up on (non-retryable answer, or retries exhausted) */
    failed: number;
    /** extra attempts made because an earlier one failed transiently */
    retries: number;
    lastSuccessAt: number | null;
    lastFailureAt: number | null;
    /** `HTTP 502` or the transport error of the last failed notification */
    lastError: string | null;
}

const MAX_TRACKED_ACCOUNTS = 10_000;

export function createWebhookDeliveryStats(now: () => number = Date.now) {
    const since = now();
    const byAccount = new Map<string, WebhookDeliveryStats>();
    const empty = (): WebhookDeliveryStats => ({
        since, delivered: 0, failed: 0, retries: 0, lastSuccessAt: null, lastFailureAt: null, lastError: null,
    });
    return {
        record(accountId: string, result: Pick<WebhookDeliveryResult, 'ok' | 'status' | 'error' | 'attempts'>): void {
            let stats = byAccount.get(accountId);
            if (!stats) {
                if (byAccount.size >= MAX_TRACKED_ACCOUNTS) {
                    const oldest = byAccount.keys().next().value;
                    if (oldest !== undefined) byAccount.delete(oldest);
                }
                stats = empty();
                byAccount.set(accountId, stats);
            }
            stats.retries += Math.max(0, result.attempts - 1);
            const at = now();
            if (result.ok) {
                stats.delivered++;
                stats.lastSuccessAt = at;
            } else {
                stats.failed++;
                stats.lastFailureAt = at;
                stats.lastError = (result.status ? `HTTP ${result.status}` : result.error ?? 'unknown error').slice(0, 200);
            }
        },
        get(accountId: string): WebhookDeliveryStats {
            return { ...(byAccount.get(accountId) ?? empty()) };
        },
    };
}

/** Process-wide counters read by GET /v1/webhook. */
export const webhookDeliveryStats = createWebhookDeliveryStats();

//
// Account-level entry points (send + count + log)
//

function logDelivery(accountId: string, sessionId: string, res: WebhookDeliveryResult): void {
    if (res.ok) {
        log({ module: 'push', userId: accountId, sessionId, status: res.status, attempts: res.attempts }, 'Webhook sent');
    } else {
        log({ module: 'push', level: 'warn', userId: accountId, sessionId, status: res.status, attempts: res.attempts, failed: true }, 'Webhook failed');
    }
}

const sendOnce: WebhookAttempt = (url, payload, deliveryId) => sendWebhook(url, payload, deliveryId);

/** Session-event path (already fire-and-forget): retries, then counts and logs the outcome. */
export async function deliverAccountWebhook(accountId: string, sessionId: string, url: string, payload: WebhookPayload): Promise<WebhookDeliveryResult> {
    const res = await deliverWebhook(url, payload, { send: sendOnce });
    webhookDeliveryStats.record(accountId, res);
    logDelivery(accountId, sessionId, res);
    return res;
}

/**
 * Request path (POST /v1/webhook/notify answers `delivered`): one attempt
 * inline so the caller is not held for the whole backoff; a transient failure
 * keeps retrying in the background and is counted when it settles.
 */
export async function sendAccountWebhookNow(accountId: string, sessionId: string, url: string, payload: WebhookPayload): Promise<WebhookSendResult> {
    const deliveryId = randomUUID();
    const first = await sendOnce(url, payload, deliveryId);
    const settle = (res: WebhookDeliveryResult) => { webhookDeliveryStats.record(accountId, res); logDelivery(accountId, sessionId, res); };
    if (isRetryableWebhookFailure(first)) {
        void deliverWebhook(url, payload, { send: sendOnce, deliveryId, firstResult: first }).then(settle, () => { /* never throws */ });
    } else {
        settle({ ...first, attempts: 1, deliveryId });
    }
    return first;
}
