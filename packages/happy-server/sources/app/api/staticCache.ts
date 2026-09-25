import path from 'node:path';
import type { FastifyStaticOptions } from '@fastify/static';

/**
 * Cache policy for files served from the bundled Web V2 build.
 *
 * Everything Vite emits under `assets/` is named
 * `<name>-<content hash>-<commit>.<ext>` (web-v2 `vite.config.ts`), so a URL
 * there never changes meaning and can be cached for a year by browsers and
 * CloudFront (its `/assets/*` behavior uses CachingOptimized, which honours the
 * origin max-age; with the default `max-age=0` it re-fetched every asset from
 * vh-sg almost every time). Anything else — `index.html`, `push-sw.js`,
 * icons, `install.sh` — keeps @fastify/static's revalidating default, because
 * those names are stable across releases.
 *
 * Returns the header to set, or null to keep the default.
 */
export const IMMUTABLE_ASSET_CACHE_CONTROL = 'public, max-age=31536000, immutable';

export function staticCacheControl(staticRoot: string, filePath: string): string | null {
    const rel = path.relative(path.resolve(staticRoot), path.resolve(filePath));
    if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
    const parts = rel.split(path.sep);
    return parts.length > 1 && parts[0] === 'assets' ? IMMUTABLE_ASSET_CACHE_CONTROL : null;
}

/** @fastify/static options for the bundled Web V2 build (api.ts). */
export function webStaticOptions(root: string): FastifyStaticOptions {
    return {
        root,
        prefix: '/',
        decorateReply: false,
        // Unknown paths go to the SPA fallback not-found handler.
        wildcard: false,
        setHeaders: (reply, filePath) => {
            const cacheControl = staticCacheControl(root, filePath);
            if (cacheControl) reply.header('cache-control', cacheControl);
        },
    };
}
