/**
 * B-823 (B-816 Q2): what left the startup path must not come back through a
 * static import. Build-level numbers (startup JS 1251KB → ~830KB br) are in
 * the PR; these guard the individual cuts.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const W = resolve(__dirname, '../..');
const read = (p: string) => readFileSync(resolve(W, p), 'utf8');

describe('B-823 startup bundle cuts', () => {
  it('no RevenueCat SDK in the web app (no key was ever configured; 789KB in the startup chunk)', () => {
    expect(read('package.json')).not.toContain('@revenuecat/');
    const sources = (readdirSync(resolve(W, 'src'), { recursive: true }) as string[])
      .filter((f) => /\.tsx?$/.test(f)).map((f) => `src/${f}`);
    expect(sources.length).toBeGreaterThan(500);
    const offenders = sources.filter((f) => /from '@revenuecat\/|from '\.\/revenueCat'|revenueCat\/revenueCat/.test(read(f)));
    expect(offenders).toEqual([]);
  });

  it('the command palette loads the settings index (en + zh-Hans tables) when it opens', () => {
    const palette = read('src/screens/command/CommandPalette.tsx');
    expect(palette).not.toMatch(/^import .*settingsIndex'/m);
    expect(palette).toContain("(settingsIndexLoad ??= import('@/screens/settings/settingsIndex'))");
  });

  it('chunks and assets are content-hashed only; the entry keeps the release version (deploy contract)', () => {
    const config = read('vite.config.ts');
    expect(config).toContain('entryFileNames: releaseEntryFileNames(APP_VERSION),');
    expect(config).toContain("chunkFileNames: 'assets/[name]-[hash].js',");
    expect(config).toContain("assetFileNames: 'assets/[name]-[hash][extname]',");
    expect(config).toContain('startupPreload(),');
  });

  it('the server image copies every build-time helper vite.config.ts imports (startupPreload, vendorChunks)', () => {
    const dockerfile = read('../../Dockerfile.server');
    expect(dockerfile).toContain('COPY packages/happy-web-v2/build packages/happy-web-v2/build');
    const config = read('vite.config.ts');
    for (const [, path] of config.matchAll(/from '\.\/(build\/[^']+)'/g)) expect(existsSync(resolve(W, `${path}.ts`)), path).toBe(true);
  });
});
