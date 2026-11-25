/**
 * B-974c: fastify glue for the daemon's loopback port.
 *   /plugin/v1/*   plugin token auth (in PluginApi), JSON ≤64KB
 *   /plugins/*     CLI → daemon, behind the normal control token
 */
import type { FastifyInstance } from 'fastify';
import { PLUGIN_API_BODY_MAX, type PluginApiRequest, type PluginApiResponse } from './localApi';

export const PLUGIN_API_PREFIX = '/plugin/v1';
const PLUGIN_API_ROUTE = `${PLUGIN_API_PREFIX}/*`;

export type PluginControlHooks = {
    handleApi: (req: PluginApiRequest) => Promise<PluginApiResponse>;
    reload: () => unknown;
    ping: (pluginId: string) => Promise<unknown>;
};

/** Exactly the wildcard route registered below; anything else keeps the control-token gate. */
export function isPluginApiRoute(routeUrl: string | undefined): boolean {
    return routeUrl === PLUGIN_API_ROUTE;
}

const ERROR_MAP: Record<string, { status: number; error: string; message: string }> = {
    FST_ERR_CTP_BODY_TOO_LARGE: { status: 413, error: 'payload_too_large', message: `request body is limited to ${PLUGIN_API_BODY_MAX} bytes` },
    FST_ERR_CTP_INVALID_MEDIA_TYPE: { status: 400, error: 'invalid_request', message: 'only application/json is accepted' },
    FST_ERR_CTP_EMPTY_JSON_BODY: { status: 400, error: 'invalid_request', message: 'empty JSON body' },
    FST_ERR_CTP_INVALID_JSON_BODY: { status: 400, error: 'invalid_request', message: 'body is not valid JSON' },
};

export function registerPluginRoutes(app: FastifyInstance, hooks: PluginControlHooks): void {
    void app.register(async (scope) => {
        scope.removeAllContentTypeParsers();
        scope.addContentTypeParser('application/json', { parseAs: 'string', bodyLimit: PLUGIN_API_BODY_MAX }, (_req, body, done) => {
            const text = typeof body === 'string' ? body : body.toString('utf8');
            if (text.trim() === '') { done(null, undefined); return; }
            try { done(null, JSON.parse(text)); } catch { done(Object.assign(new Error('invalid JSON'), { code: 'FST_ERR_CTP_INVALID_JSON_BODY', statusCode: 400 }), undefined); }
        });
        scope.setErrorHandler((error, _request, reply) => {
            const mapped = ERROR_MAP[(error as { code?: string }).code ?? ''] ?? { status: 400, error: 'invalid_request', message: 'bad request' };
            void reply.code(mapped.status).send({ error: mapped.error, message: mapped.message });
        });
        scope.route({
            method: ['GET', 'PUT', 'POST', 'PATCH', 'DELETE'],
            url: PLUGIN_API_ROUTE,
            handler: async (request, reply) => {
                const rawPath = request.url.slice(PLUGIN_API_PREFIX.length).split('?')[0] || '/';
                const auth = request.headers.authorization;
                const idem = request.headers['idempotency-key'];
                const res = await hooks.handleApi({
                    method: request.method,
                    path: rawPath,
                    query: Object.fromEntries(Object.entries((request.query ?? {}) as Record<string, unknown>).map(([k, v]) => [k, typeof v === 'string' ? v : Array.isArray(v) ? String(v[0]) : undefined])),
                    headers: { authorization: typeof auth === 'string' ? auth : undefined, 'idempotency-key': typeof idem === 'string' ? idem : undefined },
                    body: request.body,
                });
                if (res.status === 401) void reply.header('WWW-Authenticate', 'Bearer');
                if (res.status === 429 && typeof res.body.retryAfterMs === 'number') void reply.header('Retry-After', String(Math.ceil(res.body.retryAfterMs / 1000)));
                return reply.code(res.status).header('cache-control', 'no-store').send(res.body);
            },
        });
    });

    // CLI → daemon (control token).
    app.post('/plugins/reload', async () => ({ plugins: hooks.reload() }));
    app.post('/plugins/ping', async (request, reply) => {
        const id = (request.body as { id?: unknown } | undefined)?.id;
        if (typeof id !== 'string') return reply.code(400).send({ error: 'invalid_request' });
        return hooks.ping(id);
    });
}
