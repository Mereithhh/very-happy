import { describe, expect, it } from 'vitest';
import { canonicalJson, isPrivilegeReduction, manifestHash, parseLoopbackUrl, parsePluginManifest, privilegedHash } from './manifest';
import { sampleManifest } from './testFixtures';

describe('B-974c manifest (DESIGN §2.1)', () => {
    it('accepts the hello-board example', () => {
        const r = parsePluginManifest(JSON.stringify(sampleManifest()));
        expect(r.ok).toBe(true);
    });

    it.each([
        ['http://127.0.0.1:4310', true],
        ['http://[::1]:4310', true],
        ['http://127.0.0.1:4310/', true],
        ['http://localhost:4310', false],
        ['http://127.0.0.2:4310', false],
        ['http://2130706433:4310', false],
        ['http://0x7f000001:4310', false],
        ['https://127.0.0.1:4310', false],
        ['http://127.0.0.1:80', false],
        ['http://127.0.0.1:1023', false],
        ['http://127.0.0.1:65536', false],
        ['http://127.0.0.1:04310', false],
        ['http://user@127.0.0.1:4310', false],
        ['http://127.0.0.1:4310/x', false],
        ['http://127.0.0.1:4310?x=1', false],
        ['http://169.254.169.254:8080', false],
        ['http://[::ffff:127.0.0.1]:4310', false],
    ])('upstream %s → %s', (url, ok) => {
        expect(parseLoopbackUrl(url, false) !== null).toBe(ok);
    });

    it('callback may carry a path but no traversal', () => {
        expect(parseLoopbackUrl('http://127.0.0.1:4310/vh/callback', true)?.path).toBe('/vh/callback');
        expect(parseLoopbackUrl('http://127.0.0.1:4310/a/../b', true)).toBeNull();
        expect(parseLoopbackUrl('http://127.0.0.1:4310/a/%2e%2e/b', true)).toBeNull();
        expect(parseLoopbackUrl('http://127.0.0.1:4310/a?x', true)).toBeNull();
    });

    it('rejects unknown major schema, too-new minApi, permission without its field, svg icons', () => {
        const base = sampleManifest();
        expect(parsePluginManifest(JSON.stringify({ ...base, schema: 'vh-plugin/v2' }))).toMatchObject({ ok: false, code: 'unsupported_schema' });
        expect(parsePluginManifest(JSON.stringify({ ...base, minApi: 2 }))).toMatchObject({ ok: false, code: 'api_too_old' });
        expect(parsePluginManifest(JSON.stringify({ ...base, sidebar: undefined }))).toMatchObject({ ok: false, code: 'invalid_manifest' });
        expect(parsePluginManifest(JSON.stringify({ ...base, sessionWidget: false }))).toMatchObject({ ok: false, code: 'invalid_manifest' });
        expect(parsePluginManifest(JSON.stringify({ ...base, icon: '<svg/>' }))).toMatchObject({ ok: false });
        expect(parsePluginManifest(JSON.stringify({ ...base, icon: '🧩' })).ok).toBe(true);
        expect(parsePluginManifest(JSON.stringify({ ...base, name: 'a\nb' })).ok).toBe(false);
        expect(parsePluginManifest('x'.repeat(33 * 1024))).toMatchObject({ ok: false, code: 'payload_too_large' });
    });

    it('warns about unknown fields instead of failing', () => {
        const r = parsePluginManifest(JSON.stringify({ ...sampleManifest(), future: 1 }));
        expect(r.ok && r.warnings).toEqual(['unknown field "future" ignored']);
    });

    it('hashes are independent of key order; privileged hash ignores cosmetic fields', () => {
        expect(canonicalJson({ b: 1, a: [{ d: 1, c: 2 }] })).toBe('{"a":[{"c":2,"d":1}],"b":1}');
        const m = sampleManifest();
        const reordered = Object.fromEntries(Object.entries(m).reverse()) as typeof m;
        expect(manifestHash(reordered)).toBe(manifestHash(m));
        const cosmetic = sampleManifest({ version: '0.2.0', description: 'new', sidebar: { title: 'Renamed', panel: 'main' } });
        expect(privilegedHash(cosmetic)).toBe(privilegedHash(m));
        expect(manifestHash(cosmetic)).not.toBe(manifestHash(m));
        for (const changed of [
            sampleManifest({ name: 'Hello Bored' }),
            sampleManifest({ icon: 'bot' }),
            sampleManifest({ panels: [{ id: 'main', title: 'Counter', upstream: 'http://127.0.0.1:4311' }] }),
            sampleManifest({ callback: { url: 'http://127.0.0.1:4310/other' } }),
            sampleManifest({ permissions: ['sidebar', 'panel', 'decisions', 'session.widget', 'sessions.read'] }),
        ]) expect(privilegedHash(changed)).not.toBe(privilegedHash(m));
    });

    it('only a pure narrowing counts as a reduction (§3.3)', () => {
        const m = sampleManifest();
        expect(isPrivilegeReduction(m, sampleManifest({ permissions: ['sidebar', 'panel'], sessionWidget: undefined, callback: undefined }))).toBe(true);
        expect(isPrivilegeReduction(m, sampleManifest({ permissions: [...m.permissions, 'sessions.list'] }))).toBe(false);
        expect(isPrivilegeReduction(m, sampleManifest({ panels: [{ id: 'main', title: 'x', upstream: 'http://127.0.0.1:4999' }] }))).toBe(false);
        expect(isPrivilegeReduction(m, sampleManifest({ name: 'Other' }))).toBe(false);
    });
});
