/**
 * B-974c: `/plugin/v1` on the daemon (DESIGN §5). A pure request → response
 * function; `controlServer.ts` mounts it under the daemon's loopback port with
 * its own authentication (plugin token, never the control token).
 */
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
    PLUGIN_API_FEATURES, PLUGIN_LIMITS, pluginCanonicalJson,
    PluginBadgePutSchema, PluginDecisionDeleteSchema, PluginDecisionListQuerySchema, PluginDecisionPatchSchema, PluginDecisionPostSchema,
    PluginEventsAckSchema, PluginEventsPullQuerySchema, PluginSessionMessagesQuerySchema, PluginSessionsListQuerySchema, PluginWidgetPutSchema,
} from '@slopus/happy-wire';
import { PLUGIN_API_LEVEL, type PluginPermission } from './manifest';
import { checkAccess, checkInstallState, type AccessDenied, type PluginEntry, type PluginRegistry } from './registry';
import { OfflineQueue } from './offlineQueue';
import type { PluginEventHub } from './events';

export { PLUGIN_API_FEATURES };
export const PLUGIN_API_BODY_MAX = PLUGIN_LIMITS.apiBodyBytes;

function zodIssues(error: z.ZodError): Array<{ path: string; message: string }> {
    return error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message }));
}

/** Does the server publish `plugins-v1`? `unknown` until the first answer. */
export type ServerPluginSupport = 'yes' | 'no' | 'unknown';
const IDEMPOTENCY_TTL_MS = 10 * 60_000;

export type ServerOpResult =
    | { kind: 'ok'; result: Record<string, unknown> }
    | { kind: 'error'; status: number; error: string; details?: Record<string, unknown> }
    | { kind: 'offline' };
export type ServerOp = (installId: string | null, op: string, payload: Record<string, unknown>, requestId: string) => Promise<ServerOpResult>;

export type LocalSessionInfo = { id: string; title: string | null; cwd: string | null; agent: string | null; status: 'running' | 'idle' | 'archived'; updatedAt: number };
export type LocalSessionMessage = { id: string; role: 'user' | 'agent'; text: string; createdAt: number };
export type LocalSessions = {
    list(): LocalSessionInfo[];
    isLocal(sessionId: string): boolean;
    /** Text-only messages, newest `limit` before `before` (a seq cursor), read and decrypted on this machine. */
    readMessages(sessionId: string, limit: number, before?: string): Promise<{ messages: LocalSessionMessage[]; cursor: string | null }>;
};

export type PluginApiRequest = {
    method: string;
    /** Path below `/plugin/v1`, e.g. `/badge`. */
    path: string;
    query: Record<string, string | undefined>;
    headers: { authorization?: string; 'idempotency-key'?: string };
    body: unknown;
};
export type PluginApiResponse = { status: number; body: Record<string, unknown> };

const err = (status: number, error: string, message: string, extra: Record<string, unknown> = {}): PluginApiResponse => ({ status, body: { error, message, ...extra } });
const denied = (d: AccessDenied): PluginApiResponse => err(d.status, d.error, d.message, d.permission ? { permission: d.permission } : {});
const invalid = (e: z.ZodError): PluginApiResponse => err(400, 'invalid_request', 'request failed validation', { issues: zodIssues(e) });
const offline = (queued: boolean, extra: Record<string, unknown> = {}): PluginApiResponse => err(503, 'server_unreachable', queued ? 'the daemon is offline; the write is queued and will be sent on reconnect' : 'the daemon cannot reach the server', { queued, ...extra });

type Route = { method: string; pattern: RegExp; handler: (ctx: Ctx, params: string[]) => Promise<PluginApiResponse> };
type Ctx = { entry: PluginEntry; req: PluginApiRequest; requestId: string };

export class PluginApi {
    private idempotency = new Map<string, { fingerprint: string; response: PluginApiResponse; at: number }>();
    private readonly routes: Route[];

    constructor(private readonly deps: {
        registry: PluginRegistry;
        queue: OfflineQueue;
        events: PluginEventHub;
        serverOp: ServerOp;
        sessions: LocalSessions;
        machineId: () => string;
        /** r2 capability gate: `no` → every call 503 `server_too_old`, nothing queued. */
        serverSupport?: () => ServerPluginSupport;
        now?: () => number;
    }) {
        const r = (method: string, pattern: RegExp, handler: Route['handler']): Route => ({ method, pattern, handler });
        this.routes = [
            r('GET', /^\/info$/, (c) => this.info(c)),
            r('PUT', /^\/badge$/, (c) => this.badge(c)),
            r('POST', /^\/decisions$/, (c) => this.decisionPost(c)),
            r('GET', /^\/decisions$/, (c) => this.decisionList(c)),
            r('PATCH', /^\/decisions\/([^/]+)$/, (c, p) => this.decisionPatch(c, p[0])),
            r('DELETE', /^\/decisions\/([^/]+)$/, (c, p) => this.decisionDelete(c, p[0])),
            r('PUT', /^\/sessions\/([^/]+)\/widget$/, (c, p) => this.widgetPut(c, p[0])),
            r('DELETE', /^\/sessions\/([^/]+)\/widget$/, (c, p) => this.widgetDelete(c, p[0])),
            r('GET', /^\/sessions\/([^/]+)\/widget$/, (c, p) => this.widgetGet(c, p[0])),
            r('GET', /^\/sessions$/, (c) => this.sessionsList(c)),
            r('GET', /^\/sessions\/([^/]+)\/messages$/, (c, p) => this.sessionMessages(c, p[0])),
            r('GET', /^\/events$/, (c) => this.eventsList(c)),
            r('POST', /^\/events\/ack$/, (c) => this.eventsAck(c)),
        ];
    }

    private now(): number { return this.deps.now?.() ?? Date.now(); }

    async handle(req: PluginApiRequest): Promise<PluginApiResponse> {
        const entry = this.deps.registry.authenticate(req.headers.authorization);
        if (!entry) return err(401, 'unauthorized', 'missing or invalid plugin token');
        if (this.deps.serverSupport?.() === 'no') return err(503, 'server_too_old', 'the server does not support plugins (no plugins-v1); nothing was queued', { queued: false });
        const method = req.method.toUpperCase();
        let matched: { route: Route; params: string[] } | null = null;
        let pathKnown = false;
        for (const route of this.routes) {
            const m = route.pattern.exec(req.path);
            if (!m) continue;
            pathKnown = true;
            if (route.method === method) { matched = { route, params: m.slice(1).map((s) => { try { return decodeURIComponent(s); } catch { return '\u0000'; } }) }; break; }
        }
        if (!matched) return pathKnown ? err(405, 'invalid_request', 'method not allowed') : err(404, 'not_found', 'no such endpoint');
        if (matched.params.some((p) => p.includes('\u0000') || p.length === 0 || p.length > 256)) return err(400, 'invalid_request', 'bad path parameter');
        const ctx: Ctx = { entry, req, requestId: randomUUID() };
        const idemKey = req.headers['idempotency-key'];
        const isWrite = method !== 'GET';
        if (isWrite && idemKey !== undefined) {
            if (typeof idemKey !== 'string' || idemKey.length === 0 || idemKey.length > 128) return err(400, 'invalid_request', 'Idempotency-Key must be 1–128 characters');
            this.sweepIdempotency();
            const cacheKey = `${entry.record.installId}\u0000${idemKey}`;
            const fingerprint = createHash('sha256').update(`${method} ${req.path}\u0000${pluginCanonicalJson(req.body ?? null)}`).digest('hex');
            const hit = this.idempotency.get(cacheKey);
            if (hit) {
                if (hit.fingerprint !== fingerprint) return err(422, 'invalid_request', 'Idempotency-Key was used with a different request');
                return hit.response;
            }
            ctx.requestId = `idem_${createHash('sha256').update(cacheKey).digest('hex').slice(0, 32)}`;
            const response = await matched.route.handler(ctx, matched.params);
            if (response.status < 500) this.idempotency.set(cacheKey, { fingerprint, response, at: this.now() });
            return response;
        }
        return matched.route.handler(ctx, matched.params);
    }

    private sweepIdempotency(): void {
        const cutoff = this.now() - IDEMPOTENCY_TTL_MS;
        for (const [k, v] of this.idempotency) if (v.at < cutoff) this.idempotency.delete(k);
    }

    // ── helpers ─────────────────────────────────────────────────────────────

    /** Forward a write; offline → queue under `key` (newest wins). */
    private async write(ctx: Ctx, key: string, op: string, payload: Record<string, unknown>, okStatus = 200): Promise<PluginApiResponse> {
        const installId = ctx.entry.record.installId;
        // A key still waiting in the queue stays ordered behind it.
        if (!this.deps.queue.has(installId, key)) {
            const result = await this.deps.serverOp(installId, op, payload, ctx.requestId);
            if (result.kind === 'ok') {
                const status = op === 'decision.post' && result.result.created === true ? 201 : okStatus;
                return { status, body: result.result };
            }
            if (result.kind === 'error') return err(result.status, result.error, result.error, result.details);
        }
        const queued = this.deps.queue.enqueue(installId, { key, op, payload, queuedAt: this.now() });
        return queued ? offline(true) : offline(false, { limit: this.deps.queue.limit });
    }

    private async read(ctx: Ctx, op: string, payload: Record<string, unknown>): Promise<PluginApiResponse> {
        const result = await this.deps.serverOp(ctx.entry.record.installId, op, payload, ctx.requestId);
        if (result.kind === 'ok') return { status: 200, body: result.result };
        if (result.kind === 'error') return err(result.status, result.error, result.error, result.details);
        return offline(false);
    }

    private localSession(sessionId: string): PluginApiResponse | null {
        return this.deps.sessions.isLocal(sessionId) ? null : err(403, 'session_not_on_machine', 'the session is not on this machine');
    }

    // ── routes ──────────────────────────────────────────────────────────────

    private async info({ entry }: Ctx): Promise<PluginApiResponse> {
        // Answers in every state, so a plugin can tell pending / rejected / disabled apart.
        const stateDenied = checkInstallState(entry);
        return {
            status: 200,
            body: {
                apiVersion: PLUGIN_API_LEVEL,
                features: [...PLUGIN_API_FEATURES],
                installId: entry.record.installId,
                pluginId: entry.id,
                state: entry.state,
                grants: stateDenied ? [] : entry.record.grants.filter((g) => entry.manifest?.permissions.includes(g)),
                machineId: this.deps.machineId(),
            },
        };
    }

    private async badge(ctx: Ctx): Promise<PluginApiResponse> {
        const d = checkAccess(ctx.entry, { allOf: ['sidebar'] });
        if (d) return denied(d);
        const body = PluginBadgePutSchema.safeParse(ctx.req.body);
        if (!body.success) return invalid(body.error);
        return this.write(ctx, 'badge', 'badge.put', body.data);
    }

    private decisionNeeds(sessionId: unknown, panelPath: unknown): { allOf: PluginPermission[]; anyOf?: PluginPermission[] } {
        const allOf: PluginPermission[] = ['decisions'];
        if (panelPath !== undefined) allOf.push('panel');
        return sessionId !== undefined ? { allOf, anyOf: ['session.widget', 'sessions.list'] } : { allOf };
    }

    private async decisionPost(ctx: Ctx): Promise<PluginApiResponse> {
        const raw = (ctx.req.body ?? {}) as Record<string, unknown>;
        const d = checkAccess(ctx.entry, this.decisionNeeds(raw?.sessionId, raw?.panelPath));
        if (d) return denied(d);
        const body = PluginDecisionPostSchema.safeParse(ctx.req.body);
        if (!body.success) return invalid(body.error);
        if (body.data.sessionId) { const notLocal = this.localSession(body.data.sessionId); if (notLocal) return notLocal; }
        return this.write(ctx, `decision:${body.data.key}`, 'decision.post', body.data);
    }

    private async decisionPatch(ctx: Ctx, key: string): Promise<PluginApiResponse> {
        const raw = (ctx.req.body ?? {}) as Record<string, unknown>;
        const d = checkAccess(ctx.entry, this.decisionNeeds(undefined, raw?.panelPath));
        if (d) return denied(d);
        const body = PluginDecisionPatchSchema.safeParse(ctx.req.body ?? {});
        if (!body.success) return invalid(body.error);
        return this.write(ctx, `decision:${key}`, 'decision.patch', { key, ...body.data });
    }

    private async decisionDelete(ctx: Ctx, key: string): Promise<PluginApiResponse> {
        const d = checkAccess(ctx.entry, { allOf: ['decisions'] });
        if (d) return denied(d);
        const body = PluginDecisionDeleteSchema.safeParse(ctx.req.body ?? {});
        if (!body.success) return invalid(body.error);
        return this.write(ctx, `decision:${key}`, 'decision.delete', { key, ...body.data });
    }

    private async decisionList(ctx: Ctx): Promise<PluginApiResponse> {
        const d = checkAccess(ctx.entry, { allOf: ['decisions'] });
        if (d) return denied(d);
        const q = PluginDecisionListQuerySchema.safeParse(ctx.req.query);
        if (!q.success) return invalid(q.error);
        return this.read(ctx, 'decision.list', { state: q.data.state ?? 'open', limit: q.data.limit ?? 50 });
    }

    private async widgetPut(ctx: Ctx, sessionId: string): Promise<PluginApiResponse> {
        const raw = (ctx.req.body ?? {}) as Record<string, unknown>;
        const d = checkAccess(ctx.entry, { allOf: raw?.panelPath !== undefined ? ['session.widget', 'panel'] : ['session.widget'] });
        if (d) return denied(d);
        if (ctx.entry.manifest?.sessionWidget !== true) return denied({ status: 403, error: 'permission_denied', message: 'the manifest does not declare sessionWidget', permission: 'session.widget' });
        const body = PluginWidgetPutSchema.safeParse(ctx.req.body);
        if (!body.success) return invalid(body.error);
        const notLocal = this.localSession(sessionId);
        if (notLocal) return notLocal;
        return this.write(ctx, `widget:${sessionId}`, 'widget.put', { sessionId, ...body.data });
    }

    private async widgetDelete(ctx: Ctx, sessionId: string): Promise<PluginApiResponse> {
        const d = checkAccess(ctx.entry, { allOf: ['session.widget'] });
        if (d) return denied(d);
        const notLocal = this.localSession(sessionId);
        if (notLocal) return notLocal;
        return this.write(ctx, `widget:${sessionId}`, 'widget.delete', { sessionId });
    }

    private async widgetGet(ctx: Ctx, sessionId: string): Promise<PluginApiResponse> {
        const d = checkAccess(ctx.entry, { allOf: ['session.widget'] });
        if (d) return denied(d);
        const notLocal = this.localSession(sessionId);
        if (notLocal) return notLocal;
        return this.read(ctx, 'widget.get', { sessionId });
    }

    /** r2/r4: a sensitive read is audited on the server first; no `ok:true`, no data. */
    private async audit(ctx: Ctx, permission: 'sessions.list' | 'sessions.read', sessionIds: string[]): Promise<PluginApiResponse | null> {
        const audit = await this.deps.serverOp(ctx.entry.record.installId, 'audit.sensitiveRead', { permission, sessionIds }, ctx.requestId);
        if (audit.kind === 'ok') return null;
        if (audit.kind === 'offline') return offline(false);
        return err(503, 'server_unreachable', `the read could not be audited (${audit.error}); no data returned`, { queued: false });
    }

    private async sessionsList(ctx: Ctx): Promise<PluginApiResponse> {
        const d = checkAccess(ctx.entry, { allOf: ['sessions.list'] });
        if (d) return denied(d);
        const q = PluginSessionsListQuerySchema.safeParse(ctx.req.query);
        if (!q.success) return invalid(q.error);
        if (q.data.cursor !== undefined && !/^\d{1,6}$/.test(q.data.cursor)) return err(400, 'invalid_request', 'bad cursor');
        const limit = q.data.limit ?? 50;
        const all = this.deps.sessions.list().sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : 1));
        const start = q.data.cursor ? Number(q.data.cursor) : 0;
        const page = all.slice(start, start + limit);
        const refused = await this.audit(ctx, 'sessions.list', page.map((s) => s.id));
        if (refused) return refused;
        const next = start + page.length;
        return { status: 200, body: { sessions: page, cursor: next < all.length ? String(next) : null } };
    }

    private async sessionMessages(ctx: Ctx, sessionId: string): Promise<PluginApiResponse> {
        const d = checkAccess(ctx.entry, { allOf: ['sessions.read'] });
        if (d) return denied(d);
        const q = PluginSessionMessagesQuerySchema.safeParse(ctx.req.query);
        if (!q.success) return invalid(q.error);
        if (q.data.before !== undefined && !/^\d{1,10}$/.test(q.data.before)) return err(400, 'invalid_request', 'bad before cursor');
        const notLocal = this.localSession(sessionId);
        if (notLocal) return notLocal;
        const refused = await this.audit(ctx, 'sessions.read', [sessionId]);
        if (refused) return refused;
        // Read and decrypted on this machine; the content never goes to the server.
        try {
            const page = await this.deps.sessions.readMessages(sessionId, q.data.limit ?? 20, q.data.before);
            return { status: 200, body: page };
        } catch {
            return err(404, 'not_found', 'the session log is not readable on this machine');
        }
    }

    private async eventsList(ctx: Ctx): Promise<PluginApiResponse> {
        const stateDenied = checkInstallState(ctx.entry);
        if (stateDenied) return denied(stateDenied);
        const q = PluginEventsPullQuerySchema.safeParse(ctx.req.query);
        if (!q.success) return invalid(q.error);
        const result = await this.deps.events.pull(ctx.entry, q.data.after, (q.data.wait ?? 0) * 1000);
        if (result.kind === 'offline') return offline(false);
        if (result.kind === 'error') return err(result.status, result.error, result.error);
        return { status: 200, body: { events: result.events, cursor: result.cursor } };
    }

    private async eventsAck(ctx: Ctx): Promise<PluginApiResponse> {
        const stateDenied = checkInstallState(ctx.entry);
        if (stateDenied) return denied(stateDenied);
        const body = PluginEventsAckSchema.safeParse(ctx.req.body);
        if (!body.success) return invalid(body.error);
        return this.read(ctx, 'events.ack', { upTo: body.data.upTo });
    }
}
