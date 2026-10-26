import type { Plugin, Rollup } from 'vite';
import { shouldUsePublicRoot } from '../src/app/rootSelection';

/**
 * B-823 (B-816 Q3): the startup chunks are fetched in parallel with the entry.
 *
 * main.tsx picks its root with a dynamic import, so Vite only knew about the
 * entry's static imports: the root's own chunks (sync, crypto, the shell —
 * ~0.9MB br) were discovered once the entry had downloaded AND run, a second
 * serial wave (phone · slow 4G: 3.1s → 8.1s, B-816 §1.4). An inline script
 * now makes the same root choice as main.tsx (the very same function,
 * inlined) and emits `<link rel="modulepreload">` for that root's static
 * closure — plus the session screen's when the URL is a session — before
 * the entry is even parsed. Anonymous visitors still never fetch the
 * authenticated app (main.tsx's performance contract).
 */
type OutputBundle = Rollup.OutputBundle;
type OutputChunk = Rollup.OutputChunk;

export interface StartupPreloadSets {
  app: string[];
  public: string[];
  session: string[];
}

const ROOTS = {
  app: '/src/app/AppRoot.tsx',
  public: '/src/app/PublicRoot.tsx',
  session: '/src/screens/session/SessionDetailScreen.tsx',
} as const;

function chunkOf(bundle: OutputBundle, moduleSuffix: string): OutputChunk | undefined {
  return Object.values(bundle).find((item): item is OutputChunk =>
    item.type === 'chunk' && !!item.facadeModuleId?.endsWith(moduleSuffix));
}

/** A chunk's static import closure (itself included) minus `exclude`, in load order. */
export function staticClosure(bundle: OutputBundle, start: OutputChunk, exclude: ReadonlySet<string> = new Set()): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const visit = (fileName: string) => {
    if (seen.has(fileName) || exclude.has(fileName)) return;
    seen.add(fileName);
    const chunk = bundle[fileName];
    if (!chunk || chunk.type !== 'chunk') return;
    for (const dep of chunk.imports) visit(dep);
    for (const css of chunk.viteMetadata?.importedCss ?? []) if (!seen.has(css)) { seen.add(css); out.push(css); }
    out.push(fileName);
  };
  visit(start.fileName);
  return out;
}

export function startupPreloadSets(bundle: OutputBundle): StartupPreloadSets | null {
  const entry = Object.values(bundle).find((item): item is OutputChunk => item.type === 'chunk' && item.isEntry);
  if (!entry) return null;
  // Vite already modulepreloads the entry's own static imports.
  const loaded = new Set(staticClosure(bundle, entry));
  const sets: StartupPreloadSets = { app: [], public: [], session: [] };
  for (const key of Object.keys(ROOTS) as (keyof typeof ROOTS)[]) {
    const chunk = chunkOf(bundle, ROOTS[key]);
    if (chunk) sets[key] = staticClosure(bundle, chunk, loaded);
  }
  // The session screen is opened by the app root; skip what that already preloads.
  const app = new Set(sets.app);
  sets.session = sets.session.filter((file) => !app.has(file));
  return sets;
}

/**
 * The inline script. `choose` is shouldUsePublicRoot itself; the inputs mirror
 * main.tsx (stored credentials, the base-relative path) and brand.ts
 * (`__HAPPY_CONFIG__.landing !== false`).
 */
export function startupPreloadScript(sets: StartupPreloadSets, base: string): string {
  const basePath = base.replace(/\/$/, '');
  return `(function(){try{var choose=${shouldUsePublicRoot.toString()};`
    + `var S=${JSON.stringify(sets)},B=${JSON.stringify(basePath)},p=location.pathname;`
    + `var r=B&&p.indexOf(B)===0?p.slice(B.length)||'/':p;`
    + `var c=!!localStorage.getItem('auth_credentials');var h=window.__HAPPY_CONFIG__;`
    + `var pub=choose(r,c,!(h&&h.landing===false));`
    + `var files=pub?S.public:S.app.concat(/^\\/session\\/[^/]+/.test(r)?S.session:[]);`
    + `for(var i=0;i<files.length;i++){var l=document.createElement('link'),f=files[i];`
    + `if(/\\.css$/.test(f)){l.rel='preload';l.as='style';}else{l.rel='modulepreload';l.crossOrigin='';}`
    + `l.href=B+'/'+f;document.head.appendChild(l);}}catch(e){}})();`;
}

export function startupPreload(): Plugin {
  let base = '/';
  return {
    name: 'very-happy-startup-preload',
    apply: 'build',
    configResolved(config) {
      base = config.base;
    },
    transformIndexHtml: {
      order: 'post',
      handler(html, ctx) {
        const sets = ctx.bundle ? startupPreloadSets(ctx.bundle) : null;
        if (!sets) return html;
        return [{ tag: 'script', children: startupPreloadScript(sets, base), injectTo: 'head' }];
      },
    },
  };
}
