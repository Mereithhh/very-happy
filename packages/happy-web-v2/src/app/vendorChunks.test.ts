import { describe, expect, it } from 'vitest';
import { createVendorChunks, packageOf } from '../../build/vendorChunks';

const P = '/w/web';
const nm = (pkg: string, file = 'index.js') => `/w/node_modules/.pnpm/x/node_modules/${pkg}/${file}`;
/** A module graph: static imports only (dynamic imports are not edges here, like Rollup's importedIds). */
const graph: Record<string, string[]> = {
  [`${P}/src/main.tsx`]: [nm('zod'), nm('react-dom', 'client.js'), `${P}/src/text/index.ts`],
  [`${P}/src/text/index.ts`]: [],
  [`${P}/src/app/AppRoot.tsx`]: [nm('axios'), nm('lucide-react'), nm('libsodium-wrappers'), nm('some-lib', 'style.css')],
  [`${P}/src/screens/session/SessionDetailScreen.tsx`]: [nm('micromark')],
  [`${P}/src/app/PublicRoot.tsx`]: [nm('lucide-react')],
  [nm('axios')]: [nm('follow-up')],
};
const meta = { getModuleInfo: (id: string) => ({ importedIds: graph[id] ?? [] }) };

describe('B-823 release-stable vendor chunks', () => {
  it('names the npm package of a module id (scoped too), null for app code', () => {
    expect(packageOf(nm('@radix-ui/react-dialog', 'dist/index.mjs'))).toBe('@radix-ui/react-dialog');
    expect(packageOf(nm('zod', 'v4/core/index.js'))).toBe('zod');
    expect(packageOf(`${P}/src/main.tsx`)).toBeNull();
  });

  it('boot / app / fixed groups; shared-with-public, lazy-only, css and app code stay put', () => {
    const chunk = createVendorChunks(`${P}/`);
    expect(chunk(nm('zod'), meta)).toBe('vendor-boot');
    expect(chunk(nm('react-dom', 'client.js'), meta)).toBe('vendor-react');
    expect(chunk(nm('libsodium-wrappers'), meta)).toBe('crypto');
    expect(chunk(nm('axios'), meta)).toBe('vendor-app');
    expect(chunk(nm('follow-up'), meta)).toBe('vendor-app'); // transitively static
    expect(chunk(nm('micromark'), meta)).toBe('vendor-app'); // the session screen's startup
    expect(chunk(nm('lucide-react'), meta)).toBeUndefined(); // the anonymous root needs it: never in vendor-app
    expect(chunk(nm('some-lib', 'style.css'), meta)).toBeUndefined();
    expect(chunk(nm('lazy-only-lib'), meta)).toBeUndefined();
    expect(chunk(`${P}/src/text/index.ts`, meta)).toBeUndefined();
  });
});
