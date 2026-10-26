import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { startupPreloadScript, startupPreloadSets, type StartupPreloadSets } from '../../build/startupPreload';

/** The rollup output shape the plugin reads (fileName, imports, facade, css). */
function chunk(fileName: string, imports: string[], facade?: string, css: string[] = [], isEntry = false) {
    return { type: 'chunk', fileName, imports, facadeModuleId: facade ?? null, isEntry, viteMetadata: { importedCss: new Set(css) } };
}
const W = '/repo/packages/happy-web-v2';
const bundle = Object.fromEntries([
    chunk('assets/index-E.js', ['assets/vendor-react-R.js'], `${W}/src/main.tsx`, [], true),
    chunk('assets/vendor-react-R.js', []),
    chunk('assets/AppRoot-A.js', ['assets/vendor-react-R.js', 'assets/Markdown-M.js', 'assets/crypto-C.js'], `${W}/src/app/AppRoot.tsx`, ['assets/AppRoot-A.css']),
    chunk('assets/Markdown-M.js', ['assets/crypto-C.js']),
    chunk('assets/crypto-C.js', []),
    chunk('assets/PublicRoot-P.js', ['assets/vendor-react-R.js', 'assets/Landing-L.js'], `${W}/src/app/PublicRoot.tsx`),
    chunk('assets/Landing-L.js', []),
    chunk('assets/SessionDetailScreen-S.js', ['assets/Markdown-M.js', 'assets/session-x.js'], `${W}/src/screens/session/SessionDetailScreen.tsx`),
    chunk('assets/session-x.js', []),
].map((c) => [c.fileName, c])) as never;

/** Run the inline script against a fake page; returns the preload links it added. */
function run(sets: StartupPreloadSets, opts: { path: string; creds: boolean; base?: string; landing?: boolean }) {
    const links: Array<{ rel: string; as?: string; href: string; crossOrigin?: string }> = [];
    const window = { __HAPPY_CONFIG__: opts.landing === false ? { landing: false } : undefined };
    runInNewContext(startupPreloadScript(sets, opts.base ?? '/'), {
        window,
        location: { pathname: opts.path },
        localStorage: { getItem: (k: string) => (k === 'auth_credentials' && opts.creds ? '{"token":"t"}' : null) },
        document: {
            createElement: () => ({}) as never,
            head: { appendChild: (l: never) => links.push(l) },
        },
    });
    return links;
}

describe('B-823 startup preload (B-816 Q3)', () => {
    const sets = startupPreloadSets(bundle)!;

    it('each root gets its static closure, without what the entry already preloads; the session screen only adds its own', () => {
        expect(sets.app).toEqual(['assets/crypto-C.js', 'assets/Markdown-M.js', 'assets/AppRoot-A.css', 'assets/AppRoot-A.js']);
        expect(sets.public).toEqual(['assets/Landing-L.js', 'assets/PublicRoot-P.js']);
        expect(sets.session).toEqual(['assets/session-x.js', 'assets/SessionDetailScreen-S.js']);
    });

    it('a signed-in session URL preloads the app root and the session screen', () => {
        const links = run(sets, { path: '/session/abc', creds: true });
        expect(links.map((l) => l.href)).toEqual([...sets.app, ...sets.session].map((f) => `/${f}`));
        expect(links.filter((l) => l.rel === 'modulepreload').every((l) => l.crossOrigin === '')).toBe(true);
        expect(links.find((l) => l.href.endsWith('.css'))).toMatchObject({ rel: 'preload', as: 'style' });
    });

    it('signed-in home: the app root only', () => {
        expect(run(sets, { path: '/', creds: true }).map((l) => l.href)).toEqual(sets.app.map((f) => `/${f}`));
    });

    it('anonymous visitors never fetch the app (main.tsx performance contract); /welcome and share links stay public', () => {
        expect(run(sets, { path: '/', creds: false }).map((l) => l.href)).toEqual(sets.public.map((f) => `/${f}`));
        expect(run(sets, { path: '/welcome', creds: true }).map((l) => l.href)).toEqual(sets.public.map((f) => `/${f}`));
        expect(run(sets, { path: '/s/link1', creds: true }).map((l) => l.href)).toEqual(sets.public.map((f) => `/${f}`));
    });

    it('same choice as main.tsx for a relay without a landing page, and under a base path', () => {
        expect(run(sets, { path: '/', creds: false, landing: false }).map((l) => l.href)).toEqual(sets.app.map((f) => `/${f}`));
        expect(run(sets, { path: '/v2/session/abc', creds: true, base: '/v2/' }).map((l) => l.href)).toEqual([...sets.app, ...sets.session].map((f) => `/v2/${f}`));
    });

    it('a broken environment (storage throws) adds nothing and does not throw', () => {
        expect(() => runInNewContext(startupPreloadScript(sets, '/'), { window: {}, location: { pathname: '/' }, localStorage: { getItem: () => { throw new Error('denied'); } }, document: {} })).not.toThrow();
    });

    it('main.tsx makes the same choice from the same function', () => {
        const main = readFileSync(resolve(__dirname, '../main.tsx'), 'utf8');
        expect(main).toContain('const usePublicRoot = shouldUsePublicRoot(routePath, hasStoredCredentials, BRAND.landingEnabled);');
        expect(main).toContain("const hasStoredCredentials = Boolean(localStorage.getItem('auth_credentials'));");
    });
});
