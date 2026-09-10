import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { spaFallback } from './spaFallback';

describe('SPA fallback', () => {
  it('never returns an HTML success for missing assets, APIs or non-GET requests', async () => {
    const app = Fastify();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-spa-test-'));
    fs.writeFileSync(path.join(dir, 'index.html'), '<html><head></head><body>shell</body></html>');
    app.setNotFoundHandler(spaFallback(dir, null));
    try {
      for (const url of ['/assets/WebTerminalRoute-old.js', '/assets/missing?x=1', '/sw.js', '/v2/missing', '/v1/missing', '/v3/missing', '/files/missing', '/health/missing']) {
        const res = await app.inject({ url });
        expect(res.statusCode, url).toBe(404);
        expect(res.headers['cache-control'], url).toBe('no-store');
        expect(res.headers['content-type'], url).not.toContain('text/html');
      }
      const route = await app.inject({ url: '/session/a?tab=files' });
      expect(route.statusCode).toBe(200);
      expect(route.headers['content-type']).toContain('text/html');
      expect(route.body).toContain('shell');
      expect((await app.inject({ method: 'POST', url: '/session/a' })).statusCode).toBe(404);
    } finally { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
