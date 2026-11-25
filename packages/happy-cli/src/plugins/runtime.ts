/**
 * B-974c: wires the plugin pieces into the daemon — registry, `/plugin/v1`,
 * offline queue, events, panel forwarding — and keeps local install state in
 * step with the server (install sync on connect, `plugin-install-changed`).
 */
import { logger } from '@/ui/logger';
import { PLUGIN_PERMISSIONS, type PluginPermission } from './manifest';
import { PluginRegistry } from './registry';
import { PluginStore, SERVER_INSTALL_STATES, applyServerInstall, effectiveState, isLiveState, type ServerInstallState } from './store';
import { OfflineQueue, type QueuedOp } from './offlineQueue';
import { PluginEventHub } from './events';
import { PluginApi, type LocalSessions, type ServerOp, type PluginApiRequest, type PluginApiResponse } from './localApi';
import { PluginHttpForwarder } from './pluginHttp';

export type InstallView = { installId: string; pluginId: string; state: ServerInstallState; grants: PluginPermission[]; manifestHash: string | null };

/** Lenient parse of one server install view; unknown grants are dropped. */
export function parseInstallView(raw: unknown): InstallView | null {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    if (typeof r.installId !== 'string' || typeof r.pluginId !== 'string') return null;
    if (typeof r.state !== 'string' || !(SERVER_INSTALL_STATES as readonly string[]).includes(r.state)) return null;
    const grants = Array.isArray(r.grants) ? r.grants.filter((g): g is PluginPermission => (PLUGIN_PERMISSIONS as readonly string[]).includes(g as string)) : [];
    return { installId: r.installId, pluginId: r.pluginId, state: r.state as ServerInstallState, grants, manifestHash: typeof r.manifestHash === 'string' ? r.manifestHash : null };
}

export class PluginRuntime {
    readonly store: PluginStore;
    readonly registry: PluginRegistry;
    readonly queue: OfflineQueue;
    readonly events: PluginEventHub;
    readonly api: PluginApi;
    readonly forwarder: PluginHttpForwarder;
    private apiBase: string | null = null;
    private syncing: Promise<void> | null = null;

    constructor(private readonly deps: { home: string; machineId: () => string; serverOp: ServerOp; sessions: LocalSessions }) {
        this.store = new PluginStore(deps.home);
        this.registry = new PluginRegistry(this.store);
        this.queue = new OfflineQueue((installId, items) => this.persistFor(installId, 'queue.json', items));
        this.events = new PluginEventHub({
            registry: this.registry,
            reportResult: (installId, eventId, status, attempt) => {
                void deps.serverOp(installId, 'events.result', { eventId, status, attempt }, `evr_${eventId}_${attempt}`).catch(() => undefined);
            },
            persist: (installId, state) => this.persistFor(installId, 'events.json', state),
        });
        this.api = new PluginApi({ registry: this.registry, queue: this.queue, events: this.events, serverOp: deps.serverOp, sessions: deps.sessions, machineId: deps.machineId });
        this.forwarder = new PluginHttpForwarder(this.registry);
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
            this.events.load(entry.record.installId, this.store.readFileJson(entry.id, 'events.json'));
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

    /** `plugin-install-changed` RPC / one row of `installs.sync`. */
    applyInstallView(view: InstallView): boolean {
        const id = this.store.listIds().find((pid) => this.store.readInstall(pid)?.installId === view.installId);
        if (!id || id !== view.pluginId) return false;
        const before = this.store.readInstall(id);
        const { record, promoted, credentialsCreated } = applyServerInstall(this.store, id, view);
        if (promoted || credentialsCreated || before?.state !== record.state) logger.debug(`[PLUGINS] ${id}: ${before?.state ?? '-'} → ${record.state}${promoted ? ' (approved manifest)' : ''}${credentialsCreated ? ' (credentials created)' : ''}`);
        this.reload();
        return true;
    }

    /** On every (re)connect: sync installs, replay queued writes, fetch undelivered events. */
    onConnected(): Promise<void> {
        if (this.syncing) return this.syncing;
        this.syncing = this.sync().finally(() => { this.syncing = null; });
        return this.syncing;
    }

    private async sync(): Promise<void> {
        if (this.store.listIds().length === 0) return;
        const res = await this.deps.serverOp(null, 'installs.sync', { machineId: this.deps.machineId() }, `sync_${Date.now()}`);
        if (res.kind !== 'ok') { logger.debug(`[PLUGINS] install sync skipped (${res.kind === 'error' ? res.error : 'offline'})`); return; }
        const views = Array.isArray(res.result.installs) ? res.result.installs.map(parseInstallView).filter((v): v is InstallView => v !== null) : [];
        const seen = new Set<string>();
        for (const view of views) if (this.applyInstallView(view)) seen.add(view.installId);
        // Removed on the account side: stop serving it, keep files until `plugin remove`.
        for (const id of this.store.listIds()) {
            const record = this.store.readInstall(id);
            if (record && !seen.has(record.installId) && record.state !== 'disabled') {
                this.store.writeInstall(id, { ...record, state: 'disabled', updatedAt: Date.now() });
            }
        }
        this.reload();
        for (const entry of this.registry.list()) {
            const installId = entry.record.installId;
            if (!isLiveState(entry.state)) { this.queue.clear(installId); continue; }
            await this.queue.drain(installId, async (item) => {
                const r = await this.deps.serverOp(installId, item.op, item.payload, `q_${installId}_${item.key}_${item.queuedAt}`);
                if (r.kind === 'offline') return 'offline';
                if (r.kind === 'error') logger.debug(`[PLUGINS] queued ${item.op} for ${entry.id} refused: ${r.error}`);
                return 'sent';
            });
            const pending = await this.deps.serverOp(installId, 'events.pending', {}, `evp_${installId}_${Date.now()}`);
            if (pending.kind === 'ok' && Array.isArray(pending.result.events)) for (const event of pending.result.events) this.events.receive(event);
        }
    }

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

/** The `plugin-*` machine RPCs this daemon answers (§4.5, §5.5, §3). */
export function pluginRpcHandlers(runtime: PluginRuntime): Record<string, (params: unknown) => Promise<unknown>> {
    return {
        'plugin-http': async (params) => runtime.forwarder.handle(params as never),
        'plugin-http-body': async (params) => runtime.forwarder.acceptBodyChunk((params ?? {}) as never),
        'plugin-http-pull': async (params) => runtime.forwarder.pull((params ?? {}) as never),
        'plugin-event': async (params) => {
            const event = (params as { event?: unknown } | null)?.event ?? params;
            return runtime.events.receive(event) ? { accepted: true } : { error: 'unknown_install' };
        },
        'plugin-install-changed': async (params) => {
            const view = parseInstallView(params);
            if (!view) return { error: 'invalid_request' };
            return runtime.applyInstallView(view) ? { applied: true } : { error: 'unknown_install' };
        },
    };
}

/** Sessions on this machine, as the plugin API sees them (§5.4 ownership, §5.7 list). */
export function trackedPluginSessions(opts: {
    machineId: string;
    children: () => Array<{ happySessionId?: string; happySessionMetadataFromLocalWebhook?: { path?: string; name?: string; summary?: { text: string; updatedAt: number }; flavor?: string; machineId?: string; lifecycleState?: string } }>;
    isTurnActive: (sessionId: string) => boolean;
}): LocalSessions {
    const local = () => opts.children().filter((c) => typeof c.happySessionId === 'string' && c.happySessionId.length > 0
        && (c.happySessionMetadataFromLocalWebhook?.machineId === undefined || c.happySessionMetadataFromLocalWebhook.machineId === opts.machineId));
    return {
        isLocal: (sessionId) => local().some((c) => c.happySessionId === sessionId),
        list: () => local().map((c) => {
            const m = c.happySessionMetadataFromLocalWebhook;
            const id = c.happySessionId!;
            return {
                id,
                title: m?.summary?.text ?? m?.name ?? null,
                cwd: m?.path ?? null,
                agent: m?.flavor ?? null,
                status: m?.lifecycleState === 'archived' ? 'archived' as const : opts.isTurnActive(id) ? 'running' as const : 'idle' as const,
                updatedAt: m?.summary?.updatedAt ?? 0,
            };
        }),
    };
}
