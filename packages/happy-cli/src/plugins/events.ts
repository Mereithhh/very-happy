/**
 * B-974c: VH → plugin events (DESIGN §5.5). Events arrive from the server
 * (`plugin-event` RPC, or `events.pending` after a reconnect), are kept per
 * install, pushed to the approved `callback.url` with an HMAC signature on the
 * retry schedule, and are also readable through `GET /plugin/v1/events`.
 */
import { z } from 'zod';
import { parseLoopbackUrl } from './manifest';
import { checkInstallState, type PluginEntry, type PluginRegistry } from './registry';
import { signEvent } from './signing';
import { loopbackRequest, readBody } from './loopbackHttp';

export const PluginEventSchema = z.object({
    id: z.string().min(1).max(128),
    type: z.string().min(1).max(64),
    installId: z.string().min(1).max(128),
    pluginId: z.string().min(1).max(64),
    createdAt: z.number(),
    attempt: z.number().int().nonnegative().optional(),
    data: z.record(z.string(), z.unknown()).default({}),
}).passthrough();
export type PluginEvent = z.infer<typeof PluginEventSchema>;

/** Delay after attempt n (1-based): 10 s, 1 min, 5 min, 30 min, 2 h, then every 6 h; give up 24 h after the first attempt. */
export const RETRY_DELAYS_MS = [10_000, 60_000, 300_000, 1_800_000, 7_200_000];
export const RETRY_STEADY_MS = 6 * 3_600_000;
export const RETRY_GIVE_UP_MS = 24 * 3_600_000;
export const CALLBACK_TIMEOUT_MS = 10_000;
const BUFFER_MAX = 500;
/** Events a disabled plugin still receives (so it can learn it was turned off). */
const ALWAYS_DELIVER = new Set(['install.changed', 'ping']);

export function nextRetryDelay(attempt: number): number {
    return attempt <= RETRY_DELAYS_MS.length ? RETRY_DELAYS_MS[attempt - 1] : RETRY_STEADY_MS;
}

type Slot = { seq: number; event: PluginEvent; attempts: number; firstAttemptAt: number | null; nextAt: number; status: 'pending' | 'delivered' | 'failed' };

export type CallbackPost = (url: { host: '127.0.0.1' | '::1'; port: number; path: string }, headers: Record<string, string>, body: string) => Promise<number>;

/** The real POST: loopback only, 10 s, a 2xx counts. */
export const postCallback: CallbackPost = async (url, headers, body) => {
    const res = await loopbackRequest({ host: url.host, port: url.port }, {
        method: 'POST',
        path: url.path,
        headers: { ...headers, host: url.host === '::1' ? `[::1]:${url.port}` : `127.0.0.1:${url.port}`, 'content-length': String(Buffer.byteLength(body)) },
        body: Buffer.from(body, 'utf8'),
        timeoutMs: CALLBACK_TIMEOUT_MS,
    });
    await readBody(res.body, 64 * 1024).catch(() => undefined);
    return res.status;
};

export function signedEnvelope(secret: string, event: PluginEvent, nowSec: number): { rawBody: string; headers: Record<string, string> } {
    const rawBody = JSON.stringify(event);
    return {
        rawBody,
        headers: {
            'content-type': 'application/json',
            'x-vh-event-id': event.id,
            'x-vh-timestamp': String(nowSec),
            'x-vh-signature': signEvent(secret, nowSec, event.id, rawBody),
        },
    };
}

export class PluginEventHub {
    private slots = new Map<string, Slot[]>();
    private seqs = new Map<string, number>();
    private waiters = new Map<string, Set<() => void>>();
    private delivering = new Set<string>();
    private timer: NodeJS.Timeout | null = null;

    constructor(private readonly deps: {
        registry: PluginRegistry;
        /** Tell the server how a push ended (`events.result`). */
        reportResult: (installId: string, eventId: string, status: 'delivered' | 'failed', attempt: number) => void;
        post?: CallbackPost;
        now?: () => number;
        persist?: (installId: string, state: { seq: number; slots: Slot[] }) => void;
    }) {}

    private now(): number { return this.deps.now?.() ?? Date.now(); }

    load(installId: string, state: unknown): void {
        const s = state as { seq?: number; slots?: Slot[] } | null;
        if (!s || !Array.isArray(s.slots)) return;
        this.slots.set(installId, s.slots.filter((x) => PluginEventSchema.safeParse(x?.event).success));
        this.seqs.set(installId, typeof s.seq === 'number' ? s.seq : 0);
    }

    start(intervalMs = 5_000): void {
        if (this.timer) return;
        this.timer = setInterval(() => { void this.tick(); }, intervalMs);
        this.timer.unref?.();
    }

    stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }

    private save(installId: string): void {
        this.deps.persist?.(installId, { seq: this.seqs.get(installId) ?? 0, slots: this.slots.get(installId) ?? [] });
    }

    /** Add a server event (duplicates by id are ignored). Returns false when it is not for a known install. */
    receive(raw: unknown): boolean {
        const parsed = PluginEventSchema.safeParse(raw);
        if (!parsed.success) return false;
        const event = parsed.data;
        const entry = this.deps.registry.byInstallId(event.installId);
        if (!entry || entry.id !== event.pluginId) return false;
        const list = this.slots.get(event.installId) ?? [];
        if (list.some((s) => s.event.id === event.id)) return true;
        const seq = (this.seqs.get(event.installId) ?? 0) + 1;
        this.seqs.set(event.installId, seq);
        list.push({ seq, event, attempts: 0, firstAttemptAt: null, nextAt: this.now(), status: 'pending' });
        // Cap: drop the oldest finished ones first, then the oldest.
        while (list.length > BUFFER_MAX) {
            const i = list.findIndex((s) => s.status !== 'pending');
            list.splice(i >= 0 ? i : 0, 1);
        }
        this.slots.set(event.installId, list);
        this.save(event.installId);
        for (const wake of this.waiters.get(event.installId) ?? []) wake();
        void this.deliverDue(entry);
        return true;
    }

    /** Pull API: events after `cursor` that the plugin has not acked. */
    async list(entry: PluginEntry, after: number, waitMs: number, limit = 100): Promise<{ events: Array<PluginEvent & { signature?: { timestamp: number; value: string } }>; cursor: string }> {
        const pick = () => (this.slots.get(entry.record.installId) ?? []).filter((s) => s.seq > after && s.status !== 'delivered').slice(0, limit);
        let found = pick();
        if (found.length === 0 && waitMs > 0) {
            await new Promise<void>((resolve) => {
                const set = this.waiters.get(entry.record.installId) ?? new Set();
                const wake = () => { clearTimeout(t); set.delete(wake); resolve(); };
                const t = setTimeout(wake, waitMs);
                set.add(wake);
                this.waiters.set(entry.record.installId, set);
            });
            found = pick();
        }
        const nowSec = Math.floor(this.now() / 1000);
        const events = found.map((s) => {
            if (!entry.secret) return s.event;
            return { ...s.event, signature: { timestamp: nowSec, value: signEvent(entry.secret, nowSec, s.event.id, JSON.stringify(s.event)) } };
        });
        const cursor = found.length > 0 ? found[found.length - 1].seq : after;
        return { events, cursor: String(cursor) };
    }

    /** `POST /events/ack { upTo }`: everything up to the cursor counts as delivered. */
    ack(entry: PluginEntry, upTo: number): number {
        const list = this.slots.get(entry.record.installId) ?? [];
        let acked = 0;
        for (const s of list) {
            if (s.seq <= upTo && s.status !== 'delivered') {
                s.status = 'delivered';
                acked++;
                this.deps.reportResult(entry.record.installId, s.event.id, 'delivered', Math.max(1, s.attempts));
            }
        }
        this.slots.set(entry.record.installId, list.filter((s) => s.seq > upTo));
        this.save(entry.record.installId);
        return acked;
    }

    pendingCount(installId: string): number { return (this.slots.get(installId) ?? []).filter((s) => s.status === 'pending').length; }

    async tick(): Promise<void> {
        for (const entry of this.deps.registry.list()) await this.deliverDue(entry);
    }

    private async deliverDue(entry: PluginEntry): Promise<void> {
        const installId = entry.record.installId;
        if (this.delivering.has(installId)) return;
        const callback = entry.manifest?.callback ? parseLoopbackUrl(entry.manifest.callback.url, true) : null;
        if (!callback || !entry.secret) return;
        this.delivering.add(installId);
        try {
            for (const slot of [...(this.slots.get(installId) ?? [])]) {
                if (slot.status !== 'pending' || slot.nextAt > this.now()) continue;
                if (checkInstallState(entry) && !ALWAYS_DELIVER.has(slot.event.type)) continue;
                await this.attempt(entry, slot, callback);
            }
        } finally {
            this.delivering.delete(installId);
        }
    }

    private async attempt(entry: PluginEntry, slot: Slot, callback: { host: '127.0.0.1' | '::1'; port: number; path: string }): Promise<void> {
        const now = this.now();
        slot.attempts++;
        slot.firstAttemptAt ??= now;
        const event = { ...slot.event, attempt: slot.attempts };
        const { rawBody, headers } = signedEnvelope(entry.secret!, event, Math.floor(now / 1000));
        let ok = false;
        try {
            const status = await (this.deps.post ?? postCallback)(callback, headers, rawBody);
            ok = status >= 200 && status < 300;
        } catch {
            ok = false;
        }
        const installId = entry.record.installId;
        if (ok) {
            slot.status = 'delivered';
            this.deps.reportResult(installId, slot.event.id, 'delivered', slot.attempts);
            this.slots.set(installId, (this.slots.get(installId) ?? []).filter((s) => s !== slot));
        } else {
            const next = now + nextRetryDelay(slot.attempts);
            if (next - slot.firstAttemptAt > RETRY_GIVE_UP_MS) {
                slot.status = 'failed';
                this.deps.reportResult(installId, slot.event.id, 'failed', slot.attempts);
            } else {
                slot.nextAt = next;
            }
        }
        this.save(installId);
    }

    /** `plugin doctor`: one signed `ping` straight to the callback, not queued. */
    async ping(entry: PluginEntry): Promise<{ status: number | null; error?: string }> {
        const callback = entry.manifest?.callback ? parseLoopbackUrl(entry.manifest.callback.url, true) : null;
        if (!callback) return { status: null, error: 'no callback declared' };
        if (!entry.secret) return { status: null, error: 'no secret yet (not approved)' };
        const now = this.now();
        const event: PluginEvent = { id: `evt_ping_${now.toString(36)}`, type: 'ping', installId: entry.record.installId, pluginId: entry.id, createdAt: now, attempt: 1, data: {} };
        const { rawBody, headers } = signedEnvelope(entry.secret, event, Math.floor(now / 1000));
        try {
            return { status: await (this.deps.post ?? postCallback)(callback, headers, rawBody) };
        } catch (error) {
            return { status: null, error: (error as Error).message };
        }
    }

    forget(installId: string): void {
        this.slots.delete(installId);
        this.seqs.delete(installId);
    }
}
