import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['**/*.test.ts', '**/*.spec.ts'],
  },
  // Restrict discovery to the server config. Scanning every repository
  // tsconfig would pull the intentionally unsupported legacy Expo tree into
  // clean server installs.
  plugins: [tsconfigPaths({ projects: ['./tsconfig.json'] })]
});
