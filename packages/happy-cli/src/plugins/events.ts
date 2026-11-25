/**
 * B-974c: VH → plugin events (DESIGN §5.5, r4 §5.10 "notify + pull", r5).
 *
 * The server owns the event queue. It emits `plugin-events-due { installId }`
 * (also once on every connect); the daemon then `events.pull`s, pushes each
 * event to the approved `callback.url` with an HMAC signature, and reports
 * every attempt with `events.result`. While it runs, the daemon retries a
 * failed push on the wire schedule (`pluginEventRetryDelayMs`); one in-flight
 * record per event id, so a repeated notice never double-pushes.
 *
 * Plugins without a callback pull through `GET /plugin/v1/events`, which the
 * daemon forwards to `events.pull` and signs per event (`{ event, rawBody,
 * timestamp, signature }`, signature over rawBody).
 */
import { PluginEventReadSchema, pluginEventRetryDelayMs, signPluginEvent, PLUGIN_EVENT_DELIVERY_TIMEOUT_MS } from '@slopus/happy-wire';
import { logger } from '@/ui/logger';
import { parseLoopbackUrl } from './manifest';
import { checkInstallState, type PluginEntry, type PluginRegistry } from './registry';
import { loopbackRequest, readBody } from './loopbackHttp';
import type { ServerOp } from './localApi';

export type PluginEvent = { id: string; type: string; installId: string; pluginId: string; createdAt: number; attempt: number; data: Record<string, unknown> } & Record<string, unknown>;
export type PulledEvent = { event: PluginEvent; rawBody: string; timestamp: number; signature: string };

/** Events a disabled plugin still receives (so it can learn it was turned off). */
const ALWAYS_DELIVER = new Set(['install.changed', 'ping']);
const PULL_LIMIT = 100;
export const GAVE_UP = 'gave_up';

export type CallbackTarget = { host: '127.0.0.1' | '::1'; port: number; path: string };
export type CallbackPost = (url: CallbackTarget, headers: Record<string, string>, body: string) => Promise<number>;

/** The real POST: loopback only, 10 s, the caller decides what counts as delivered. */
export const postCallback: CallbackPost = async (url, headers, body) => {
    const res = await loopbackRequest({ host: url.host, port: url.port }, {
        method: 'POST',
        path: url.path,
        headers: { ...headers, host: url.host === '::1' ? `[::1]:${url.port}` : `127.0.0.1:${url.port}`, 'content-length': String(Buffer.byteLength(body)) },
        body: Buffer.from(body, 'utf8'),
        timeoutMs: PLUGIN_EVENT_DELIVERY_TIMEOUT_MS,
    });
    await readBody(res.body, 64 * 1024).catch(() => undefined);
    return res.status;
};

/** Sign one event for push or pull: the signature covers exactly `rawBody`. */
export function signedEvent(secretKey: Uint8Array, event: PluginEvent, nowSec: number): PulledEvent {
    const rawBody = JSON.stringify(event);
    return { event, rawBody, timestamp: nowSec, signature: signPluginEvent(secretKey, nowSec, event.id, rawBody) };
}

export function pushHeaders(signed: PulledEvent): Record<string, string> {
    return {
        'content-type': 'application/json',
        'x-vh-event-id': signed.event.id,
        'x-vh-timestamp': String(signed.timestamp),
        'x-vh-signature': signed.signature,
    };
}

function parseEvents(raw: unknown, installId: string, pluginId: string): PluginEvent[] {
    if (!Array.isArray(raw)) return [];
    const out: PluginEvent[] = [];
    for (const item of raw) {
        const parsed = PluginEventReadSchema.safeParse(item);
        // An event for another install never reaches this plugin, whatever the server sent.
        if (parsed.success && parsed.data.installId === installId && parsed.data.pluginId === pluginId) out.push(parsed.data as PluginEvent);
    }
    return out;
}

type Slot = { event: PluginEvent; attempt: number; firstAttemptAt: number | null; nextAt: number };

export class PluginEventHub {
    private slots = new Map<string, Map<string, Slot>>();
    private delivering = new Set<string>();
    private dueAgain = new Set<string>();
    private waiters = new Map<string, Set<() => void>>();
    private timer: NodeJS.Timeout | null = null;

    constructor(private readonly deps: {
        registry: PluginRegistry;
        serverOp: ServerOp;
        post?: CallbackPost;
        now?: () => number;
    }) {}

    private now(): number { return this.deps.now?.() ?? Date.now(); }

    start(intervalMs = 5_000): void {
        if (this.timer) return;
        this.timer = setInterval(() => { void this.tick(); }, intervalMs);
        this.timer.unref?.();
    }

    stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }

    private report(installId: string, eventId: string, status: 'delivered' | 'failed', attempt: number, error?: string): void {
        void this.deps.serverOp(installId, 'events.result', { eventId, status, attempt, ...(error ? { error: error.slice(0, 500) } : {}) }, `evr_${eventId}_${attempt}`)
            .catch(() => undefined);
    }

    /** `plugin-events-due { installId }`: wake pullers, and push for a callback plugin. */
    async onDue(installId: string): Promise<void> {
        for (const wake of this.waiters.get(installId) ?? []) wake();
        const entry = this.deps.registry.byInstallId(installId);
        if (!entry || !this.callbackOf(entry)) return;
        if (this.delivering.has(installId)) { this.dueAgain.add(installId); return; }
        this.delivering.add(installId);
        try {
            do {
                this.dueAgain.delete(installId);
                const res = await this.deps.serverOp(installId, 'events.pull', { limit: PULL_LIMIT }, `evp_${installId}_${this.now()}`);
                if (res.kind !== 'ok') return;
                const slots = this.slots.get(installId) ?? new Map<string, Slot>();
                for (const event of parseEvents(res.result.events, installId, entry.id)) {
                    if (!slots.has(event.id)) slots.set(event.id, { event, attempt: Math.max(1, event.attempt ?? 1), firstAttemptAt: null, nextAt: this.now() });
                }
                this.slots.set(installId, slots);
                await this.deliverDue(entry);
            } while (this.dueAgain.has(installId));
        } finally {
            this.delivering.delete(installId);
        }
    }

    /** Retry timer. */
    async tick(): Promise<void> {
        for (const entry of this.deps.registry.list()) {
            const installId = entry.record.installId;
            if (this.delivering.has(installId) || !this.slots.get(installId)?.size) continue;
            this.delivering.add(installId);
            try { await this.deliverDue(entry); } finally { this.delivering.delete(installId); }
        }
    }

    private callbackOf(entry: PluginEntry): CallbackTarget | null {
        return entry.manifest?.callback && entry.secretKey ? parseLoopbackUrl(entry.manifest.callback.url, true) : null;
    }

    private async deliverDue(entry: PluginEntry): Promise<void> {
        const callback = this.callbackOf(entry);
        const slots = this.slots.get(entry.record.installId);
        if (!callback || !slots) return;
        const blocked = checkInstallState(entry) !== null;
        for (const slot of [...slots.values()]) {
            if (blocked && !ALWAYS_DELIVER.has(slot.event.type)) { slots.delete(slot.event.id); continue; }
            if (slot.nextAt > this.now()) continue;
            await this.attempt(entry, slot, callback, slots);
        }
    }

    private async attempt(entry: PluginEntry, slot: Slot, callback: CallbackTarget, slots: Map<string, Slot>): Promise<void> {
        const now = this.now();
        slot.firstAttemptAt ??= now;
        const signed = signedEvent(entry.secretKey!, { ...slot.event, attempt: slot.attempt }, Math.floor(now / 1000));
        let error: string | undefined;
        try {
            const status = await (this.deps.post ?? postCallback)(callback, pushHeaders(signed), signed.rawBody);
            if (status < 200 || status >= 300) error = `HTTP ${status}`;
        } catch (e) {
            error = (e as Error).message || 'unreachable';
        }
        const installId = entry.record.installId;
        if (error === undefined) {
            slots.delete(slot.event.id);
            this.report(installId, slot.event.id, 'delivered', slot.attempt);
            return;
        }
        const delay = pluginEventRetryDelayMs(slot.attempt, slot.firstAttemptAt, this.now());
        if (delay === null) {
            slots.delete(slot.event.id);
            this.report(installId, slot.event.id, 'failed', slot.attempt, GAVE_UP);
            logger.debug(`[PLUGINS] ${entry.id}: gave up on event ${slot.event.id} after ${slot.attempt} attempts`);
            return;
        }
        this.report(installId, slot.event.id, 'failed', slot.attempt, error);
        slot.attempt++;
        slot.nextAt = this.now() + delay;
    }

    pendingCount(installId: string): number { return this.slots.get(installId)?.size ?? 0; }

    /**
     * `GET /plugin/v1/events`: forward to `events.pull`, sign each event.
     * `wait` long-polls until a due notice (or the timeout) when nothing is there.
     */
    async pull(entry: PluginEntry, after: string | undefined, waitMs: number): Promise<{ kind: 'ok'; events: PulledEvent[]; cursor: string | null } | { kind: 'offline' } | { kind: 'error'; status: number; error: string }> {
        const installId = entry.record.installId;
        const once = async () => {
            const res = await this.deps.serverOp(installId, 'events.pull', { ...(after ? { after } : {}), limit: PULL_LIMIT }, `evq_${installId}_${this.now()}`);
            if (res.kind !== 'ok') return res;
            const nowSec = Math.floor(this.now() / 1000);
            const events = entry.secretKey ? parseEvents(res.result.events, installId, entry.id).map((e) => signedEvent(entry.secretKey!, e, nowSec)) : [];
            const cursor = typeof res.result.cursor === 'string' ? res.result.cursor : null;
            return { kind: 'ok' as const, events, cursor };
        };
        let result = await once();
        if (result.kind === 'ok' && result.events.length === 0 && waitMs > 0) {
            await new Promise<void>((resolve) => {
                const set = this.waiters.get(installId) ?? new Set();
                const wake = () => { clearTimeout(t); set.delete(wake); resolve(); };
                const t = setTimeout(wake, waitMs);
                set.add(wake);
                this.waiters.set(installId, set);
            });
            result = await once();
        }
        return result;
    }

    /** `plugin doctor`: one signed `ping` straight to the callback, not via the server. */
    async ping(entry: PluginEntry): Promise<{ status: number | null; error?: string }> {
        const callback = entry.manifest?.callback ? parseLoopbackUrl(entry.manifest.callback.url, true) : null;
        if (!callback) return { status: null, error: 'no callback declared' };
        if (!entry.secretKey) return { status: null, error: 'no secret yet (not approved)' };
        const now = this.now();
        const event: PluginEvent = { id: `evt_ping_${now.toString(36)}`, type: 'ping', installId: entry.record.installId, pluginId: entry.id, createdAt: now, attempt: 1, data: {} };
        const signed = signedEvent(entry.secretKey, event, Math.floor(now / 1000));
        try {
            return { status: await (this.deps.post ?? postCallback)(callback, pushHeaders(signed), signed.rawBody) };
        } catch (error) {
            return { status: null, error: (error as Error).message };
        }
    }

    forget(installId: string): void { this.slots.delete(installId); }
}
