/**
 * B-974c: wires the plugin pieces into the daemon — registry, `/plugin/v1`,
 * offline queue, events, panel forwarding — and keeps local install state in
 * step with the server (r4 §5.10: `install.sync` on connect and on every
 * `plugin-install-changed { installId }` notice; `plugin-events-due` → pull).
 */
import { PluginInstallSyncItemSchema } from '@slopus/happy-wire';
import { logger } from '@/ui/logger';
import type { LogEntry } from '@/sessions/turnState';
import { PLUGIN_PERMISSIONS, type PluginPermission } from './manifest';
import { PluginRegistry } from './registry';
import { PluginStore, SERVER_INSTALL_STATES, applyServerInstall, effectiveState, isLiveState, type ServerInstallState } from './store';
import { OfflineQueue, type QueuedOp } from './offlineQueue';
import { PluginEventHub } from './events';
import { PluginApi, type LocalSessionMessage, type LocalSessions, type ServerOp, type ServerPluginSupport, type PluginApiRequest, type PluginApiResponse } from './localApi';
import { PluginHttpForwarder } from './pluginHttp';
import { PLUGINS_DISABLED } from './serverOp';

export type InstallView = { installId: string; pluginId: string; state: ServerInstallState; grants: PluginPermission[]; manifestHash: string | null };

/** One `install.sync` item (r4: `{ id, pluginId, state, grants, manifest, manifestHash, pending, disabledBy? }`); unknown grants dropped. */
export function parseInstallView(raw: unknown): InstallView | null {
    const parsed = PluginInstallSyncItemSchema.safeParse(raw);
    if (!parsed.success) return null;
    const r = parsed.data;
    if (!(SERVER_INSTALL_STATES as readonly string[]).includes(r.state)) return null;
    const grants = r.grants.filter((g): g is PluginPermission => (PLUGIN_PERMISSIONS as readonly string[]).includes(g));
    return { installId: r.id, pluginId: r.pluginId, state: r.state as ServerInstallState, grants, manifestHash: r.manifestHash };
}

/** Refusals that mean "never send this again" while replaying the queue (r2). */
const DROP_ON_REPLAY = new Set(['plugin_disabled', 'permission_denied', 'plugin_rejected', 'plugin_pending', 'disabled_by_operator', 'invalid_request', 'not_found', 'session_not_on_machine', 'limit_exceeded', 'version_conflict']);

export class PluginRuntime {
    readonly store: PluginStore;
    readonly registry: PluginRegistry;
    readonly queue: OfflineQueue;
    readonly events: PluginEventHub;
    readonly api: PluginApi;
    readonly forwarder: PluginHttpForwarder;
    private apiBase: string | null = null;
    private syncing: Promise<void> | null = null;
    private support: ServerPluginSupport = 'unknown';
    private originHosts = new Map<string, string>();
    private readonly serverOp: ServerOp;

    constructor(private readonly deps: {
        home: string;
        machineId: () => string;
        serverOp: ServerOp;
        sessions: LocalSessions;
        /** r2 capability gate: does the server publish `plugins-v1`? */
        probeServerSupport: () => Promise<ServerPluginSupport>;
        /** P3-9: installId → origin host (`GET /v1/plugins/installs`), read after each install sync; best-effort. */
        fetchOriginHosts?: () => Promise<Map<string, string>>;
    }) {
        // r4/r6: `plugins_disabled` from any op = the switch is off → same as an old server: 503, nothing queued.
        const serverOp: ServerOp = async (installId, op, payload, requestId) => {
            const result = await deps.serverOp(installId, op, payload, requestId);
            if (result.kind === 'error' && result.error === PLUGINS_DISABLED) {
                this.markUnsupported();
                return { kind: 'error', status: 503, error: 'server_too_old', details: { queued: false } };
            }
            return result;
        };
        this.serverOp = serverOp;
        this.store = new PluginStore(deps.home);
        this.registry = new PluginRegistry(this.store);
        this.queue = new OfflineQueue((installId, items) => this.persistFor(installId, 'queue.json', items));
        this.events = new PluginEventHub({ registry: this.registry, serverOp });
        this.api = new PluginApi({ registry: this.registry, queue: this.queue, events: this.events, serverOp, sessions: deps.sessions, machineId: deps.machineId, serverSupport: () => this.support });
        this.forwarder = new PluginHttpForwarder(this.registry, { originHost: (installId) => this.originHosts.get(installId) ?? null });
    }

    private persistFor(installId: string, file: string, value: unknown): void {
        const entry = this.registry.byInstallId(installId);
        if (!entry) return;
        try { this.store.writeFileJson(entry.id, file, value); } catch (error) { logger.debug(`[PLUGINS] persist ${file} failed`, error); }
    }

    /** Daemon start: load everything and point each plugin at this port. */
    start(controlPort: number): void {
        this.apiBase = `http://127.0.0.1:${controlPort}/plugin/v1`;
        this.reload();
        for (const entry of this.registry.list()) {
            const queued = this.store.readFileJson(entry.id, 'queue.json');
            if (Array.isArray(queued)) this.queue.load(entry.record.installId, queued as QueuedOp[]);
        }
        this.events.start();
    }

    stop(): void {
        this.events.stop();
        this.forwarder.shutdown();
    }

    /** Re-read disk (after a CLI change or a server update) and refresh runtime.json. */
    reload(): ReturnType<PluginRegistry['reload']> {
        const entries = this.registry.reload();
        for (const entry of entries) {
            if (!isLiveState(entry.state)) this.forwarder.closeInstall(entry.record.installId);
            try { this.store.writeRuntime(entry.id, { api: this.apiBase, installId: entry.record.installId, state: entry.state }); } catch (error) { logger.debug('[PLUGINS] runtime.json write failed', error); }
        }
        return entries;
    }

    handleApi(req: PluginApiRequest): Promise<PluginApiResponse> { return this.api.handle(req); }

    serverSupport(): ServerPluginSupport { return this.support; }

    /** One row of `install.sync`. */
    applyInstallView(view: InstallView): boolean {
        const id = this.store.listIds().find((pid) => this.store.readInstall(pid)?.installId === view.installId);
        if (!id || id !== view.pluginId) return false;
        const before = this.store.readInstall(id);
        const { record, promoted, credentialsCreated } = applyServerInstall(this.store, id, view);
        if (promoted || credentialsCreated || before?.state !== record.state) logger.debug(`[PLUGINS] ${id}: ${before?.state ?? '-'} → ${record.state}${promoted ? ' (approved manifest)' : ''}${credentialsCreated ? ' (credentials created)' : ''}`);
        return true;
    }

    /** On every (re)connect: capability check, install sync, queue replay, then events. */
    onConnected(): Promise<void> {
        if (this.syncing) return this.syncing;
        this.syncing = this.connectSequence().finally(() => { this.syncing = null; });
        return this.syncing;
    }

    /** `plugin-install-changed { installId }`: re-sync (the notice carries no state). */
    async onInstallChanged(installId: string): Promise<void> {
        if (!this.registry.byInstallId(installId) && !this.store.listIds().some((id) => this.store.readInstall(id)?.installId === installId)) return;
        await this.syncInstalls();
    }

    /** `plugin-events-due { installId }`. */
    onEventsDue(installId: string): Promise<void> { return this.events.onDue(installId); }

    private async connectSequence(): Promise<void> {
        this.support = await this.deps.probeServerSupport().catch(() => 'unknown' as const);
        if (this.support === 'no') { this.markUnsupported(); return; }
        if (this.store.listIds().length === 0) return;
        // r2 order: state first (disable / revoke / approve), then the queue.
        if (!await this.syncInstalls()) return;
        for (const entry of this.registry.list()) {
            const installId = entry.record.installId;
            if (!isLiveState(entry.state)) { this.queue.clear(installId); continue; }
            await this.queue.drain(installId, async (item) => {
                const r = await this.serverOp(installId, item.op, item.payload, `q_${installId}_${item.queuedAt}_${item.key}`.slice(0, 128));
                if (r.kind === 'offline') return 'offline';
                if (r.kind === 'error') logger.warn(`[PLUGINS] ${entry.id}: queued ${item.op} (${item.key}) ${DROP_ON_REPLAY.has(r.error) ? 'refused' : 'failed'} by the server (${r.error}); dropped`);
                return 'sent';
            });
        }
        for (const entry of this.registry.list()) if (isLiveState(entry.state)) void this.events.onDue(entry.record.installId);
    }

    /** r2: an old server (or plugins switched off) never takes plugin writes; do not pile them up. */
    private markUnsupported(): void {
        this.support = 'no';
        for (const entry of this.registry.list()) if (this.queue.size(entry.record.installId) > 0) {
            logger.debug(`[PLUGINS] server has no plugins-v1; dropping ${this.queue.size(entry.record.installId)} queued writes of ${entry.id}`);
            this.queue.clear(entry.record.installId);
        }
    }

    /** `install.sync` and apply; false when the server could not be asked. */
    private async syncInstalls(): Promise<boolean> {
        const res = await this.serverOp(null, 'install.sync', {}, `sync_${Date.now()}`);
        if (res.kind !== 'ok') { logger.debug(`[PLUGINS] install sync skipped (${res.kind === 'error' ? res.error : 'offline'})`); return false; }
        const views = Array.isArray(res.result.installs) ? res.result.installs.map(parseInstallView).filter((v): v is InstallView => v !== null) : [];
        const seen = new Set<string>();
        for (const view of views) if (this.applyInstallView(view)) seen.add(view.installId);
        // Gone from the account: stop serving it; files stay until `plugin remove`.
        for (const id of this.store.listIds()) {
            const record = this.store.readInstall(id);
            if (record && !seen.has(record.installId) && record.state !== 'removed') {
                this.store.writeInstall(id, { ...record, state: 'removed', updatedAt: Date.now() });
            }
        }
        this.reload();
        await this.refreshOriginHosts();
        return true;
    }

    /** P3-9: keep the last good map when the read fails (the origin of an install never changes). */
    private async refreshOriginHosts(): Promise<void> {
        if (!this.deps.fetchOriginHosts) return;
        try {
            const fresh = await this.deps.fetchOriginHosts();
            for (const [installId, host] of fresh) this.originHosts.set(installId, host);
        } catch (error) {
            logger.debug('[PLUGINS] origin read failed; X-Forwarded-Host falls back to request headers', error);
        }
    }

    /** Test hook / diagnostics. */
    originHostOf(installId: string): string | null { return this.originHosts.get(installId) ?? null; }

    /** `very-happy plugin list/show` through the daemon. */
    describe(): Array<{ id: string; installId: string; state: string; grants: string[]; queued: number; pendingEvents: number }> {
        return this.registry.list().map((e) => ({
            id: e.id,
            installId: e.record.installId,
            state: effectiveState(e.record),
            grants: e.record.grants,
            queued: this.queue.size(e.record.installId),
            pendingEvents: this.events.pendingCount(e.record.installId),
        }));
    }
}

/**
 * The panel RPCs (§4.5), registered as ordinary encrypted handlers; the RPC
 * manager scopes them to `${machineId}:plugin-http` etc. (r4).
 */
export function pluginRpcHandlers(runtime: PluginRuntime): Record<string, (params: unknown) => Promise<unknown>> {
    return {
        'plugin-http': async (params) => runtime.forwarder.handle(params as never),
        'plugin-http-body': async (params) => runtime.forwarder.acceptBodyChunk((params ?? {}) as never),
        'plugin-http-pull': async (params) => runtime.forwarder.pull((params ?? {}) as never),
    };
}

function squash(text: string): string { return text.replace(/\s+/g, ' ').trim(); }

function nonEmpty(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function positive(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
    const out: R[] = new Array(items.length);
    let next = 0;
    const worker = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i]); } };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return out;
}

/**
 * §5.7: text only — user prompts and agent replies; no tool input/output,
 * no thinking, no attachments. Bodies are the decrypted session log entries.
 */
export function messageFromLogEntry(entry: LogEntry): LocalSessionMessage | null {
    const b = entry.body as Record<string, any> | null;
    if (!b || typeof b !== 'object') return null;
    const at = entry.createdAt ?? 0;
    const make = (role: 'user' | 'agent', text: unknown) => {
        const t = typeof text === 'string' ? squash(text) : '';
        return t.length > 0 ? { id: String(entry.seq), role, text: t, createdAt: at } : null;
    };
    if (b.role === 'user' && b.content?.type === 'text') return make('user', b.content.text);
    if (b.role === 'session' && b.content?.ev?.t === 'text' && !b.content.ev.thinking) return make(b.content.role === 'user' ? 'user' : 'agent', b.content.ev.text);
    if (b.role === 'agent' && b.content?.type === 'acp' && b.content.data?.type === 'message') return make('agent', b.content.data.message);
    if (b.role === 'agent' && b.content?.type === 'output' && Array.isArray(b.content.data?.message?.content)) {
        const texts = b.content.data.message.content.filter((c: any) => c?.type === 'text' && typeof c.text === 'string').map((c: any) => c.text);
        return make(b.content.data.message.role === 'user' ? 'user' : 'agent', texts.join(' '));
    }
    return null;
}

/** Sessions on this machine, as the plugin API sees them (§5.4 ownership, §5.7). */
export function trackedPluginSessions(opts: {
    machineId: string;
    children: () => Array<{ happySessionId?: string; happySessionMetadataFromLocalWebhook?: { path?: string; name?: string; summary?: { text: string; updatedAt: number }; flavor?: string; machineId?: string; lifecycleState?: string } }>;
    isTurnActive: (sessionId: string) => boolean;
    /** Decrypted log entries (ascending seq) with seq < beforeSeq, read with this machine's session key. */
    readLog: (sessionId: string, limit: number, beforeSeq: number) => Promise<LogEntry[]>;
    /**
     * P3-10: the session's current title and last update from the server (decrypted here). The daemon's own
     * metadata is the spawn-time snapshot — no title yet, no update time — so without this the list said
     * `title: null, updatedAt: 0`. Best-effort, cached for `liveTtlMs`.
     */
    liveInfo?: (sessionId: string) => Promise<{ title?: string; updatedAt?: number } | null>;
    liveTtlMs?: number;
    now?: () => number;
}): LocalSessions {
    const now = opts.now ?? Date.now;
    const ttl = opts.liveTtlMs ?? 60_000;
    const cache = new Map<string, { at: number; info: { title?: string; updatedAt?: number } | null }>();
    const live = async (sessionId: string): Promise<{ title?: string; updatedAt?: number } | null> => {
        if (!opts.liveInfo) return null;
        const hit = cache.get(sessionId);
        if (hit && now() - hit.at < ttl) return hit.info;
        let info: { title?: string; updatedAt?: number } | null = null;
        try { info = await opts.liveInfo(sessionId); } catch { info = hit?.info ?? null; }
        cache.set(sessionId, { at: now(), info });
        return info;
    };
    const local = () => opts.children().filter((c) => typeof c.happySessionId === 'string' && c.happySessionId.length > 0
        && (c.happySessionMetadataFromLocalWebhook?.machineId === undefined || c.happySessionMetadataFromLocalWebhook.machineId === opts.machineId));
    return {
        isLocal: (sessionId) => local().some((c) => c.happySessionId === sessionId),
        list: async () => {
            const children = local();
            const ids = new Set(children.map((c) => c.happySessionId!));
            for (const key of cache.keys()) if (!ids.has(key)) cache.delete(key);
            const infos = await mapLimit(children, 8, (c) => live(c.happySessionId!));
            return children.map((c, i) => {
                const m = c.happySessionMetadataFromLocalWebhook;
                const id = c.happySessionId!;
                const fresh = infos[i];
                const title = nonEmpty(fresh?.title) ?? nonEmpty(m?.summary?.text) ?? nonEmpty(m?.name);
                const updatedAt = positive(fresh?.updatedAt) ?? positive(m?.summary?.updatedAt);
                return {
                    id,
                    ...(title ? { title } : {}),
                    cwd: m?.path ?? null,
                    agent: m?.flavor ?? null,
                    status: m?.lifecycleState === 'archived' ? 'archived' as const : opts.isTurnActive(id) ? 'running' as const : 'idle' as const,
                    ...(updatedAt ? { updatedAt } : {}),
                };
            });
        },
        readMessages: async (sessionId, limit, before) => {
            const beforeSeq = before ? Number(before) : 2147483647;
            // Over-read: most log entries are tool calls / lifecycle, not text.
            const entries = await opts.readLog(sessionId, Math.min(500, limit * 10), beforeSeq);
            const messages = entries.map(messageFromLogEntry).filter((m): m is LocalSessionMessage => m !== null).slice(-limit);
            const oldestSeq = entries.length > 0 ? entries[0].seq : null;
            return { messages, cursor: oldestSeq !== null && oldestSeq > 1 && entries.length >= Math.min(500, limit * 10) ? String(oldestSeq) : null };
        },
    };
}
