/**
 * B-823 (B-816 Q2): what left the startup path must not come back through a
 * static import. Build-level numbers (startup JS 1251KB → ~830KB br) are in
 * the PR; these guard the individual cuts.
 */
import { readdirSync, readFileSync } from 'node:fs';
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

  it('asset names are content-hashed only (no release salt)', () => {
    const config = read('vite.config.ts');
    expect(config).toContain("entryFileNames: 'assets/[name]-[hash].js',");
    expect(config).toContain("chunkFileNames: 'assets/[name]-[hash].js',");
    expect(config).toContain("assetFileNames: 'assets/[name]-[hash][extname]',");
    expect(config).toContain('startupPreload(),');
  });
});
