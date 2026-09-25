import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { describe, expect, it } from 'vitest';
import { IMMUTABLE_ASSET_CACHE_CONTROL, staticCacheControl, webStaticOptions } from './staticCache';
import { spaFallback } from './spaFallback';

describe('static cache policy', () => {
    it('marks only files under assets/ immutable', () => {
        const root = '/srv/web';
        expect(staticCacheControl(root, '/srv/web/assets/index-abc123-e4525396c.js')).toBe(IMMUTABLE_ASSET_CACHE_CONTROL);
        expect(staticCacheControl(root, '/srv/web/assets/fonts/x-abc.woff2')).toBe(IMMUTABLE_ASSET_CACHE_CONTROL);
        expect(staticCacheControl(root, '/srv/web/index.html')).toBeNull();
        expect(staticCacheControl(root, '/srv/web/push-sw.js')).toBeNull();
        expect(staticCacheControl(root, '/srv/web/assets')).toBeNull();
        expect(staticCacheControl(root, '/srv/other/assets/x.js')).toBeNull();
    });

    it('serves hashed assets immutable and the shell revalidating', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-static-cache-'));
        fs.mkdirSync(path.join(dir, 'assets'));
        fs.writeFileSync(path.join(dir, 'index.html'), '<html><head></head><body>shell</body></html>');
        fs.writeFileSync(path.join(dir, 'push-sw.js'), 'self.addEventListener("push",()=>{})');
        fs.writeFileSync(path.join(dir, 'assets', 'index-abc123-e4525396c.js'), 'console.log(1)');
        const app = Fastify();
        await app.register(fastifyStatic, webStaticOptions(dir));
        app.setNotFoundHandler(spaFallback(dir, null));
        try {
            const asset = await app.inject({ url: '/assets/index-abc123-e4525396c.js' });
            expect(asset.statusCode).toBe(200);
            expect(asset.headers['cache-control']).toBe(IMMUTABLE_ASSET_CACHE_CONTROL);
            for (const url of ['/', '/index.html', '/push-sw.js']) {
                const res = await app.inject({ url });
                expect(res.statusCode, url).toBe(200);
                expect(res.headers['cache-control'], url).toBe('public, max-age=0');
            }
            const missing = await app.inject({ url: '/assets/gone-old-deadbeef.js' });
            expect(missing.statusCode).toBe(404);
            expect(missing.headers['cache-control']).toBe('no-store');
        } finally {
            await app.close();
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
