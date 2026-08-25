import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

describe('terminal preferred-face route wiring', () => {
  it('resolves the mirror before the heavy xterm screen is imported', () => {
    const app = read('../../app/AppRoot.tsx');
    const route = read('./WebTerminalRoute.tsx');
    expect(app).toContain("import('@/screens/terminal/WebTerminalRoute')");
    expect(app).not.toContain("import('@/screens/terminal/WebTerminalScreen')");
    expect(route).toContain("lazy(() => import('./WebTerminalScreen')");
    expect(route.indexOf('resolveTerminalOpenPath({')).toBeLessThan(route.indexOf('return <WebTerminalScreen />'));
    expect(route).toContain("return <Navigate to={target} replace />");
  });
});
