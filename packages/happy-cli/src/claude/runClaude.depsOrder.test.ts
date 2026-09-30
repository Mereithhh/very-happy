import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// B-512 follow-up: evaluating the post-webhook modules is CPU-bound on the
// wrapper's only thread. Prefetching them before the daemon webhook delayed
// the webhook by ~0.6 s on a loaded dev-sg, so the first load must start only
// after notifyDaemonSessionStarted.
describe('runClaude post-webhook deps loading order', () => {
    const source = readFileSync(new URL('./runClaude.ts', import.meta.url), 'utf8');

    it('does not start loading runClaudeDeps before the daemon webhook', () => {
        const notify = source.indexOf('await notifyDaemonSessionStarted(');
        const firstLoad = source.search(/^\s+loadDeps\(\);$/m);
        expect(notify).toBeGreaterThan(0);
        expect(firstLoad).toBeGreaterThan(notify);
    });

    it('only imports runClaudeDeps through the lazy loader', () => {
        const imports = source.match(/import\('\.\/runClaudeDeps'\)/g) ?? [];
        expect(imports).toHaveLength(1);
        expect(source).toContain("const importRunClaudeDeps = () => import('./runClaudeDeps');");
        expect(source).not.toMatch(/const depsLoad = import\(/);
    });
});
