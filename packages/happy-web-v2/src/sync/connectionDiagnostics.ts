import type { ConnectionDiagnosticEvent } from '@slopus/happy-wire';

type Config = { endpoint: string; token: string; client: string };
type Stage = ConnectionDiagnosticEvent['stage'];
type Outcome = ConnectionDiagnosticEvent['outcome'];
const CAPACITY = 32;

/** Memory-only, bounded retry queue. No payloads, URLs, error strings or credentials enter an event. */
export class ConnectionDiagnostics {
    private config: Config | null = null;
    private queue: ConnectionDiagnosticEvent[] = [];
    private timer: ReturnType<typeof setTimeout> | undefined;
    private controller: AbortController | undefined;
    private generation = 0;
    private flushing = false;
    private retryMs = 5_000;
    constructor(private send: typeof fetch = (...args) => fetch(...args)) {}

    configure(config: Config | null) {
        if (this.config?.token === config?.token && this.config?.endpoint === config?.endpoint) return;
        this.generation++;
        clearTimeout(this.timer);
        this.timer = undefined;
        this.controller?.abort();
        this.queue = [];
        this.flushing = false;
        this.retryMs = 5_000;
        this.config = config;
    }

    record(event: ConnectionDiagnosticEvent) {
        if (!this.config) return;
        this.queue.push(event);
        this.queue = this.queue.slice(-CAPACITY);
        this.schedule();
    }

    private schedule() {
        if (this.timer || this.flushing || !this.config || !this.queue.length) return;
        this.timer = setTimeout(() => { this.timer = undefined; void this.flush(); }, this.retryMs);
        (this.timer as unknown as { unref?: () => void }).unref?.();
    }

    async flush() {
        if (this.flushing || !this.config || !this.queue.length) return;
        clearTimeout(this.timer); this.timer = undefined;
        const config = this.config;
        const generation = this.generation;
        const events = this.queue.splice(0, CAPACITY);
        const controller = new AbortController();
        this.controller = controller;
        this.flushing = true;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            const response = await Promise.race([
                this.send(`${config.endpoint}/v1/diagnostics/connections`, {
                    method: 'POST', headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ events }), signal: controller.signal,
                }),
                new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('diagnostic deadline')); }, 5_000); }),
            ]);
            if (generation !== this.generation) return;
            // Older servers and expired credentials must not cause endless retry traffic.
            if ([401, 403, 404].includes(response.status)) { this.configure(null); return; }
            if (!response.ok && response.status !== 400 && response.status !== 422) throw new Error('diagnostic upload unavailable');
            this.retryMs = 5_000;
        } catch {
            if (generation === this.generation) {
                this.queue = [...events, ...this.queue].slice(-CAPACITY);
                this.retryMs = Math.min(this.retryMs * 2, 60_000);
            }
        } finally {
            clearTimeout(timer);
            if (generation === this.generation) {
                this.flushing = false;
                this.controller = undefined;
                this.schedule();
            }
        }
    }

    epoch() { return this.generation; }
    client() { return this.config?.client ?? 'web/unknown'; }
}

export const connectionDiagnostics = new ConnectionDiagnostics();
export const newConnectionAttempt = () => globalThis.crypto?.randomUUID?.();

export function startConnectionStage(stage: Stage, machineId?: string, attemptId: string | undefined = newConnectionAttempt()) {
    const started = Date.now();
    const generation = connectionDiagnostics.epoch();
    const emit = (outcome: Outcome) => {
        if (!attemptId || generation !== connectionDiagnostics.epoch()) return;
        const rawClient = connectionDiagnostics.client();
        connectionDiagnostics.record({
            attemptId, ...(machineId ? { machineId } : {}), stage, outcome,
            at: Date.now(), durationMs: Math.min(300_000, Math.max(0, Date.now() - started)),
            client: /^web\/[a-f0-9]{7,40}$/.test(rawClient) ? rawClient : 'web/unknown',
            deviceClass: typeof matchMedia === 'function' ? (matchMedia('(pointer: coarse)').matches ? 'mobile' : 'desktop') : 'unknown',
            visibility: typeof document !== 'undefined' && document.visibilityState === 'hidden' ? 'hidden' : 'visible',
        });
    };
    emit('started');
    return { attemptId, finish: emit };
}

export function connectionFailureOutcome(error: unknown): 'timeout' | 'error' {
    return error instanceof Error && /timeout|timed out|deadline/i.test(error.message) ? 'timeout' : 'error';
}
