import type { FastifyRequest, FastifyReply } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import { injectRuntimeConfig } from './htmlConfigInjection';

export function spaFallback(staticDir: string, injectScript: string | null) {
    return async (request: FastifyRequest, reply: FastifyReply) => {
        const pathname = new URL(request.raw.url || '/', 'http://localhost').pathname;
        // A retired hashed chunk is not an SPA route. A 200 HTML response would
        // also be cached by the asset CacheFirst worker, poisoning future reads.
        const reserved = /^\/(?:v[123](?:\/|$)|socket|files(?:\/|$)|metrics|health|assets(?:\/|$))/;
        const resource = /\.(?:js|mjs|css|map|json|webmanifest|wasm|woff2?|ttf|png|svg|ico|jpe?g|webp)$/i;
        if (request.method !== 'GET' || reserved.test(pathname) || resource.test(pathname)) {
            return reply.header('cache-control', 'no-store').code(404).send({ error: 'Not found' });
        }
        const indexPath = path.join(staticDir, 'index.html');
        if (!fs.existsSync(indexPath)) return reply.code(404).send({ error: 'Not found' });
        const html = fs.readFileSync(indexPath, 'utf8');
        return reply.header('cache-control', 'no-cache').type('text/html').send(
            injectScript ? injectRuntimeConfig(html, injectScript) : html,
        );
    };
}
