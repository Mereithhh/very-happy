import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config';

/**
 * B-658: component tests import their subject in beforeAll (after
 * installBrowserTestGlobals). One such import is ~150-350 app modules — any
 * component that reads `sync/storage` pulls the whole sync engine through
 * `storage.ts → sync.ts`, and `useTranslation` loads all nine locale tables —
 * each transformed and evaluated by vite-node. Measured on dev-sg for
 * ToolGroupView alone: 10-14 s at load ~8, 20-25 s at load ~20 (locale tables
 * 2-4 s, sync graph 5-8 s); every dependency from node_modules is < 0.4 s.
 * The 10 s default therefore measured CPU contention, not a hang. These
 * timeouts still catch a genuinely stuck hook or test.
 */
export default mergeConfig(viteConfig, defineConfig({
  test: {
    hookTimeout: 60_000,
    testTimeout: 30_000,
  },
}));
