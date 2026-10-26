import type { Rollup } from 'vite';

/**
 * B-823 (B-816 Q3): third-party code on the startup path lives in chunks
 * whose names survive a release.
 *
 * Content hashes alone do not keep a chunk across a deploy: a chunk's hash
 * covers the file names it imports, and almost every app chunk imports the
 * entry (shared app modules live there), whose name changes with any release
 * — so every chunk that imports app code is re-fetched (a version-only build:
 * 143 of 600 files). Libraries import no app code, so a library chunk keeps
 * its name until the library itself changes. Previously only react and
 * libsodium were split out; react-dom/client, zod, axios, socket.io and the
 * markdown stack rode inside app chunks and were re-downloaded on every
 * release.
 *
 *  - `vendor-react`, `crypto`, `xterm`: as before (now by package, so
 *    `react-dom/client` no longer slips into the entry).
 *  - `vendor-boot`: other libraries the entry (main.tsx) imports statically —
 *    both roots load these anyway.
 *  - `vendor-app`: libraries the signed-in startup (AppRoot, the session
 *    screen) imports statically and the anonymous root does not — public
 *    visitors never fetch it (main.tsx's performance contract).
 *  - anything else (lazy-only libraries) stays where Rollup puts it.
 */
const ROOTS = {
  boot: '/src/main.tsx',
  app: ['/src/app/AppRoot.tsx', '/src/screens/session/SessionDetailScreen.tsx'],
  public: '/src/app/PublicRoot.tsx',
} as const;

const FIXED: Record<string, string> = {
  react: 'vendor-react',
  'react-dom': 'vendor-react',
  'react-router': 'vendor-react',
  'react-router-dom': 'vendor-react',
  scheduler: 'vendor-react',
  'libsodium-wrappers': 'crypto',
  libsodium: 'crypto',
  tweetnacl: 'crypto',
  '@xterm/xterm': 'xterm',
  '@xterm/addon-fit': 'xterm',
  '@xterm/addon-web-links': 'xterm',
};

/** The npm package of a module id, or null for app code. */
export function packageOf(id: string): string | null {
  const at = id.lastIndexOf('/node_modules/');
  if (at < 0) return null;
  const parts = id.slice(at + '/node_modules/'.length).split('/');
  return parts[0].startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0];
}

type ModuleInfoLookup = (id: string) => Pick<Rollup.ModuleInfo, 'importedIds'> | null;

/** Module ids statically reachable from `roots` (dynamic imports are a boundary). */
export function staticReach(roots: readonly string[], getModuleInfo: ModuleInfoLookup): Set<string> {
  const seen = new Set<string>();
  const stack = [...roots];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const next of getModuleInfo(id)?.importedIds ?? []) stack.push(next);
  }
  return seen;
}

export function createVendorChunks(projectRoot: string) {
  let reach: { boot: Set<string>; app: Set<string>; public: Set<string> } | null = null;
  const abs = (p: string) => `${projectRoot.replace(/\/$/, '')}${p}`;
  return (id: string, meta: { getModuleInfo: ModuleInfoLookup }): string | undefined => {
    const pkg = packageOf(id);
    // Stylesheets keep their place: moving a library's CSS to another chunk
    // would change the cascade order against the app's own rules.
    if (!pkg || /\.css(?:$|\?)/.test(id)) return undefined;
    if (FIXED[pkg]) return FIXED[pkg];
    reach ??= {
      boot: staticReach([abs(ROOTS.boot)], meta.getModuleInfo),
      app: staticReach(ROOTS.app.map(abs), meta.getModuleInfo),
      public: staticReach([abs(ROOTS.public)], meta.getModuleInfo),
    };
    if (reach.boot.has(id)) return 'vendor-boot';
    if (reach.app.has(id) && !reach.public.has(id)) return 'vendor-app';
    return undefined;
  };
}
