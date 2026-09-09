import { randomUUID } from 'node:crypto';

export type AuditInput = {
    kind: string;
    accountId?: string;
    sessionId?: string;
    messageId?: string;
    messageSeq?: number;
    ip?: string;
    ipSource?: string;
    userAgent?: string;
    method?: string;
    route?: string;
    payload?: Record<string, unknown>;
};
export type AuditEvent = AuditInput & { v: 1; id: string; sourceId: string; seq: number; at: string };
type Options = {
    url: string; token: string; fetch?: typeof fetch; sourceId?: string;
    maxEvents?: number; maxBytes?: number; maxEventBytes?: number;
    timeoutMs?: number; now?: () => number;
};

/** Best-effort, bounded, process-local transport. Never awaited by business work. */
export class AuditProducer {
    readonly sourceId: string;
    readonly startedAt: string;
    private queue: Array<{ json: string; bytes: number }> = [];
    private bytes = 0;
    private sequence = 0;
    private dropped = 0;
    private errors = 0;
    private sent = 0;
    private running = false;
    private retryAt = 0;
    private failures = 0;
    private pendingBatch?: Array<{ json: string; bytes: number }>;
    private timer?: ReturnType<typeof setInterval>;
    constructor(private readonly options: Options) { this.sourceId = options.sourceId ?? randomUUID(); this.startedAt = new Date(this.now()).toISOString(); }
    status() { return { dropped: this.dropped, errors: this.errors, sent: this.sent, queued: this.queue.length, seq: this.sequence, queueBytes: this.bytes, startedAt: this.startedAt }; }
    enqueue(input: AuditInput): boolean {
        const seq = ++this.sequence;
        try {
            if (this.queue.length >= (this.options.maxEvents ?? 256)) { this.dropped++; return false; }
            const event: AuditEvent = { ...input, v: 1, id: `${this.sourceId}:${seq}`, sourceId: this.sourceId, seq, at: new Date(this.now()).toISOString() };
            const json = JSON.stringify(event);
            const bytes = Buffer.byteLength(json);
            if (bytes > (this.options.maxEventBytes ?? 2 * 1024 * 1024) || this.bytes + bytes > (this.options.maxBytes ?? 8 * 1024 * 1024)) {
                this.dropped++; return false;
            }
            this.queue.push({ json, bytes });
            this.bytes += bytes;
            // Transport starts on its timer, never within a request/transaction callback.
            return true;
        } catch { this.dropped++; this.errors++; return false; }
    }
    private now() { return (this.options.now ?? Date.now)(); }
    start() {
        if (this.timer) return;
        let ticks = 0;
        this.timer = setInterval(() => {
            ticks++;
            if (this.queue.length > 0 || ticks % 10 === 0) void this.flush();
        }, 1000);
        this.timer.unref();
        void this.flush();
    }
    stop() { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
    async flush(): Promise<void> {
        if (this.running || this.now() < this.retryAt) return;
        this.running = true;
        let totalBytes = 0;
        const batch: typeof this.queue = [];
        for (const row of this.pendingBatch ?? this.queue.slice(0, 16)) {
            if (totalBytes + row.bytes > 3 * 1024 * 1024) break;
            batch.push(row); totalBytes += row.bytes;
        }
        this.pendingBatch = batch;
        // Only a contiguous prefix may be removed following ACK.
        const count = batch.length;
        const body = `{"sourceId":${JSON.stringify(this.sourceId)},"status":${JSON.stringify(this.status())},"events":[${batch.map((row) => row.json).join(',')}]}`;
        try {
            const response = await (this.options.fetch ?? fetch)(this.options.url, {
                method: 'POST', headers: { authorization: `Bearer ${this.options.token}`, 'content-type': 'application/json' },
                body, signal: AbortSignal.timeout(this.options.timeoutMs ?? 3000), redirect: 'error',
            });
            // Collector's 2xx contract is durable persistence, not merely acceptance.
            await response.body?.cancel();
            if (!response.ok) throw new Error('audit-delivery-failed');
            this.queue.splice(0, count);
            this.bytes -= totalBytes;
            this.sent += count;
            this.pendingBatch = undefined;
            this.failures = 0;
            this.retryAt = 0;
        } catch {
            this.errors++;
            this.failures++;
            if (this.failures >= 3) {
                this.queue.splice(0, count);
                this.bytes -= totalBytes;
                this.dropped += count;
                this.pendingBatch = undefined;
                this.failures = 0;
            }
            this.retryAt = this.now() + Math.min(30_000, 1000 * 2 ** Math.min(this.failures - 1, 5));
        } finally { this.running = false; }
    }
}

let producer: AuditProducer | undefined;
export function businessAuditEnabled(): boolean {
    return Boolean(process.env.BUSINESS_AUDIT_URL && process.env.BUSINESS_AUDIT_TOKEN);
}
export function publishAudit(input: AuditInput): void {
    if (!businessAuditEnabled()) return;
    try {
        if (!producer) {
            producer = new AuditProducer({ url: process.env.BUSINESS_AUDIT_URL!, token: process.env.BUSINESS_AUDIT_TOKEN! });
            producer.start();
        }
        producer.enqueue(input);
    } catch { /* Business work cannot depend on audit availability. */ }
}
export function startBusinessAudit(): void {
    if (!businessAuditEnabled()) return;
    if (producer) { producer.start(); return; }
    producer = new AuditProducer({ url: process.env.BUSINESS_AUDIT_URL!, token: process.env.BUSINESS_AUDIT_TOKEN! });
    producer.start();
}
export function stopBusinessAudit(): void { producer?.stop(); }
