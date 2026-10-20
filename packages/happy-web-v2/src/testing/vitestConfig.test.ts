import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// B-658: a 10 s hook/test timeout turned machine load into red component tests.
describe('B-658 web vitest timeouts', () => {
  const config = readFileSync(resolve(__dirname, '../../vitest.config.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

  it('extends the app vite config instead of replacing it (aliases, shims, define)', () => {
    expect(config).toContain("mergeConfig(viteConfig, defineConfig({");
    expect(config).toContain("import viteConfig from './vite.config';");
  });

  it('gives beforeAll imports and heavy tests room under load', () => {
    expect(Number(/hookTimeout:\s*([\d_]+)/.exec(config)?.[1].replace(/_/g, ''))).toBeGreaterThanOrEqual(60_000);
    expect(Number(/testTimeout:\s*([\d_]+)/.exec(config)?.[1].replace(/_/g, ''))).toBeGreaterThanOrEqual(30_000);
  });
});
