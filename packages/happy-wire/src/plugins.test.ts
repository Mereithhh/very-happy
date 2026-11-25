import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
    ATTENTION_ITEM_KINDS,
    ATTENTION_ITEM_SOURCES,
    ATTENTION_KINDS,
    ATTENTION_SOURCES,
    AttentionItemAnySchema,
    AttentionItemListQuerySchema,
    AttentionItemOwnerRespondSchema,
    AttentionItemPostSchema,
    AttentionItemSchema,
    AttentionPluginPayloadSchema,
    attentionItemNeedsOwner,
    attentionPushKind,
    attentionQueryIncludesPlugin,
    ATTENTION_ITEM_LINK_TYPES,
    ATTENTION_LINK_TYPES,
    AttentionItemLinkSchema,
    attentionLinkedSessionId,
    isAttentionPluginItem,
    isSessionAttentionItem,
    parsePluginPayload,
    parsePluginReviewPayload,
    AttentionPluginReviewPayloadSchema,
} from './attention';
import {
    PLUGIN_ERROR_STATUS,
    PLUGIN_OPS,
    PLUGIN_OP_PAYLOAD_SCHEMAS,
    PLUGIN_OP_PERMISSION,
    PLUGIN_OP_RESULT_SCHEMAS,
    PluginAuditListResponseSchema,
    PluginInstallDetailSchema,
    PluginInstallSyncItemSchema,
    PluginOpAckSchema,
    PluginOpRequestSchema,
    UpdatePluginWidgetBodySchema,
    isPluginPanelPath,
    pluginOpError,
    pluginOpMissingPermission,
    pluginPendingDiff,
    PluginBadgePutSchema,
    PluginBridgeRequestSchema,
    PluginDecisionPatchSchema,
    PluginDecisionPostSchema,
    PluginEventReadSchema,
    PluginEventSchema,
    PluginHttpRequestSchema,
    PluginInstallApproveSchema,
    PluginInstallViewSchema,
    PluginWidgetPutSchema,
    isPluginEmojiIcon,
    normalizePluginRequestPath,
    parsePluginLoopbackUrl,
    parsePluginManifest,
    parsePluginManifestJson,
    pluginBadgeCountsGlobally,
    pluginBadgeText,
    pluginBridgeRequiredPermissions,
    pluginDecisionMissingPermission,
    pluginDefaultGrants,
    pluginEventRetryDelayMs,
    pluginInstallHash8,
    pluginManifestHash,
    pluginManifestUnknownKeys,
    pluginOrigin,
    pluginPrivilegedDiff,
    pluginPrivilegedHash,
    pluginStateError,
    pluginUpdateNeedsApproval,
    type PluginManifest,
} from './plugins';

const HELLO = {
    schema: 'vh-plugin/v1',
    id: 'hello-board',
    name: 'Hello Board',
    version: '0.1.0',
    description: 'Demo of all four extension points',
    publisher: { name: 'Example' },
    icon: 'kanban',
    minApi: 1,
    permissions: ['sidebar', 'panel', 'decisions', 'session.widget'],
    sidebar: { title: 'Hello', panel: 'main' },
    panels: [{ id: 'main', title: 'Counter', upstream: 'http://127.0.0.1:4310', entry: '/' }],
    callback: { url: 'http://127.0.0.1:4310/vh/callback' },
    sessionWidget: true,
};
// Hash vectors published in docs/plugin-api-v1.md.
const HELLO_MANIFEST_HASH = '59c637899563ea643ba5c3827411dd55ffd70d02126e9357a55ce670be9641eb';
const HELLO_PRIVILEGED_HASH = '0e687a30ca8475d4cfedb665d8ef2ece98d554acc6ea2c4e3c725804980fe4d5';
const HELLO_PRIVILEGED_CANONICAL = '{"callbackUrl":"http://127.0.0.1:4310/vh/callback","icon":"kanban","id":"hello-board","name":"Hello Board","panels":[{"id":"main","upstream":"http://127.0.0.1:4310"}],"permissions":["decisions","panel","session.widget","sidebar"],"sessionWidget":true,"sidebarPanel":"main"}';

function parse(raw: unknown): PluginManifest {
    const r = parsePluginManifest(raw);
    if (!r.ok) throw new Error(JSON.stringify(r));
    return r.manifest;
}
function issues(raw: unknown): string {
    const r = parsePluginManifest(raw);
    return r.ok ? 'OK' : `${r.error} ${JSON.stringify(r.issues ?? r.message)}`;
}
const with_ = (patch: Record<string, unknown>) => ({ ...HELLO, ...patch });

describe('vh-plugin/v1 manifest', () => {
    it('parses the documented example', () => {
        const m = parse(HELLO);
        expect(m.panels?.[0].entry).toBe('/');
        expect(parsePluginManifestJson(JSON.stringify(HELLO)).ok).toBe(true);
    });
    it('fills defaults: icon puzzle, minApi 1, entry /', () => {
        const { icon, minApi, ...rest } = HELLO;
        const m = parse({ ...rest, panels: [{ id: 'main', title: 'Counter', upstream: 'http://127.0.0.1:4310' }] });
        expect(m.icon).toBe('puzzle');
        expect(m.minApi).toBe(1);
        expect(m.panels?.[0].entry).toBe('/');
    });
    it('rejects another major schema as unsupported_schema', () => {
        expect(parsePluginManifest(with_({ schema: 'vh-plugin/v2' }))).toMatchObject({ ok: false, error: 'unsupported_schema' });
        const { schema, ...noSchema } = HELLO;
        expect(parsePluginManifest(noSchema)).toMatchObject({ ok: false, error: 'unsupported_schema' });
        expect(parsePluginManifest(null)).toMatchObject({ ok: false, error: 'unsupported_schema' });
    });
    it('strips unknown keys and reports them for a warning', () => {
        const r = parsePluginManifest(with_({ zeta: 1, alpha: true }));
        expect(r).toMatchObject({ ok: true, unknownKeys: ['alpha', 'zeta'] });
        expect(r.ok && 'zeta' in r.manifest).toBe(false);
        expect(pluginManifestUnknownKeys(HELLO)).toEqual([]);
    });
    it('rejects files over 32KB and non-JSON', () => {
        expect(parsePluginManifestJson(JSON.stringify(with_({ pad: 'x'.repeat(33 * 1024) })))).toMatchObject({ ok: false, error: 'payload_too_large' });
        expect(parsePluginManifestJson('{')).toMatchObject({ ok: false, error: 'invalid_manifest' });
    });
    it('id pattern', () => {
        for (const id of ['ab', 'hello-board', '0x', 'a'.repeat(32)]) expect(issues(with_({ id }))).toBe('OK');
        for (const id of ['a', '-ab', 'Hello', 'a_b', 'a'.repeat(33), 'a.b']) expect(issues(with_({ id }))).not.toBe('OK');
    });
    it('name: 1-40, no control or bidi characters', () => {
        expect(issues(with_({ name: 'x'.repeat(40) }))).toBe('OK');
        expect(issues(with_({ name: 'x'.repeat(41) }))).not.toBe('OK');
        expect(issues(with_({ name: '' }))).not.toBe('OK');
        expect(issues(with_({ name: 'a\nb' }))).not.toBe('OK');
        expect(issues(with_({ name: 'a‮b' }))).not.toBe('OK');
        expect(issues(with_({ name: 'a\u0007b' }))).not.toBe('OK');
    });
    it('version is semver ≤32', () => {
        for (const version of ['1.0.0', '0.1.0-beta.1', '1.2.3+build.5']) expect(issues(with_({ version }))).toBe('OK');
        for (const version of ['1.0', 'v1.0.0', '01.0.0', `1.0.0-${'a'.repeat(30)}`]) expect(issues(with_({ version }))).not.toBe('OK');
    });
    it('icon: built-in name or one emoji, never SVG or URL', () => {
        for (const icon of ['bot', 'terminal', '🎉', '👍🏽', '👩‍💻', '🇸🇬', '1️⃣']) expect(issues(with_({ icon }))).toBe('OK');
        for (const icon of ['<svg/>', 'https://x/y.png', 'data:image/png;base64,AA', 'nope', '🎉🎉', 'a', '']) expect(issues(with_({ icon }))).not.toBe('OK');
        expect(isPluginEmojiIcon('🎉')).toBe(true);
        expect(isPluginEmojiIcon('🎉x')).toBe(false);
    });
    it('publisher url is https only', () => {
        expect(issues(with_({ publisher: { name: 'X', url: 'https://example.com' } }))).toBe('OK');
        expect(issues(with_({ publisher: { name: 'X', url: 'http://example.com' } }))).not.toBe('OK');
        expect(issues(with_({ publisher: { name: 'X', url: 'javascript:alert(1)' } }))).not.toBe('OK');
    });
    it('permissions: known and unique', () => {
        expect(issues(with_({ permissions: ['sidebar', 'panel', 'decisions', 'session.widget', 'sessions.list', 'sessions.read'] }))).toBe('OK');
        expect(issues(with_({ permissions: ['sidebar', 'panel', 'decisions', 'session.widget', 'sessions.send'] }))).not.toBe('OK');
        expect(issues(with_({ permissions: ['sidebar', 'sidebar', 'panel', 'decisions', 'session.widget'] }))).not.toBe('OK');
    });
    it('feature fields and permissions must match', () => {
        expect(issues(with_({ permissions: ['panel', 'decisions', 'session.widget'] }))).toContain('sidebar');
        expect(issues(with_({ sidebar: undefined }))).toContain('sidebar permission needs');
        expect(issues(with_({ sidebar: { title: 'Hello', panel: 'nope' } }))).toContain('sidebar.panel');
        expect(issues(with_({ panels: undefined }))).toContain('panel');
        expect(issues(with_({ permissions: ['sidebar', 'decisions', 'session.widget'] }))).toContain('panels need the panel permission');
        expect(issues(with_({ sessionWidget: false }))).toContain('session.widget permission needs');
        expect(issues(with_({ permissions: ['sidebar', 'panel', 'decisions'] }))).toContain('sessionWidget needs');
        expect(issues({ schema: 'vh-plugin/v1', id: 'dec', name: 'Only decisions', version: '1.0.0', permissions: ['decisions'] })).toBe('OK');
    });
    it('panels: 1-4, unique ids, id pattern', () => {
        const p = (id: string, port = 4310) => ({ id, title: 'T', upstream: `http://127.0.0.1:${port}` });
        expect(issues(with_({ panels: [p('main'), p('b'), p('c'), p('d')] }))).toBe('OK');
        expect(issues(with_({ panels: [p('main'), p('b'), p('c'), p('d'), p('e')] }))).not.toBe('OK');
        expect(issues(with_({ panels: [] }))).not.toBe('OK');
        expect(issues(with_({ panels: [p('main'), p('main', 4311)] }))).not.toBe('OK');
        expect(issues(with_({ panels: [p('Main')], sidebar: { title: 'x', panel: 'Main' } }))).not.toBe('OK');
    });
    it('panel entry must be an origin-relative path', () => {
        const entry = (e: string) => issues(with_({ panels: [{ id: 'main', title: 'T', upstream: 'http://127.0.0.1:4310', entry: e }] }));
        expect(entry('/app/?tab=1')).toBe('OK');
        for (const e of ['app', '//evil.example', 'https://evil.example/', '/a/../b', '/%2e%2e/x', '/a\\b']) expect(entry(e)).not.toBe('OK');
    });
});

describe('loopback addresses (SSRF: only declared loopback IP literals)', () => {
    it('upstream: exactly http://127.0.0.1:<port> or http://[::1]:<port>', () => {
        expect(parsePluginLoopbackUrl('http://127.0.0.1:4310', false)).toEqual({ host: '127.0.0.1', port: 4310, path: '/' });
        expect(parsePluginLoopbackUrl('http://[::1]:65535', false)).toEqual({ host: '::1', port: 65535, path: '/' });
        expect(parsePluginLoopbackUrl('http://127.0.0.1:1024', false)).not.toBeNull();
        for (const bad of [
            'http://localhost:4310', 'http://127.0.0.2:4310', 'http://0.0.0.0:4310', 'http://10.0.0.1:4310',
            'http://169.254.169.254:80', 'https://127.0.0.1:4310', 'http://127.0.0.1', 'http://127.0.0.1:1023',
            'http://127.0.0.1:65536', 'http://127.0.0.1:04310', 'http://127.0.0.1:4310/', 'http://127.0.0.1:4310/x',
            'http://user@127.0.0.1:4310', 'http://127.0.0.1:4310?x=1', 'http://127.0.0.1:4310#x', 'http://[::ffff:127.0.0.1]:4310',
            'http://127.1:4310', 'http://2130706433:4310', ' http://127.0.0.1:4310', 'http://127.0.0.1:4310 ',
        ]) expect(parsePluginLoopbackUrl(bad, false), bad).toBeNull();
    });
    it('callback: same host rules, path allowed, no query or traversal', () => {
        expect(parsePluginLoopbackUrl('http://127.0.0.1:4310/vh/callback', true)).toEqual({ host: '127.0.0.1', port: 4310, path: '/vh/callback' });
        expect(parsePluginLoopbackUrl('http://127.0.0.1:4310', true)?.path).toBe('/');
        for (const bad of [
            'http://localhost:4310/cb', 'http://127.0.0.1:4310/cb?x=1', 'http://127.0.0.1:4310/a/../b', 'http://127.0.0.1:4310/a/./b',
            'http://127.0.0.1:4310//evil', 'http://127.0.0.1:4310/a%2fb', 'http://127.0.0.1:4310/a%5cb', 'http://127.0.0.1:4310/a%00',
            'http://127.0.0.1:4310/a\\b', 'http://127.0.0.1:4310/cb#f', 'http://u:p@127.0.0.1:4310/cb',
        ]) expect(parsePluginLoopbackUrl(bad, true), bad).toBeNull();
        expect(issues(with_({ callback: { url: 'http://127.0.0.1:4310/cb?x=1' } }))).not.toBe('OK');
    });
});

describe('normalizePluginRequestPath (§4.6 step 3)', () => {
    it('keeps valid paths and queries as sent', () => {
        expect(normalizePluginRequestPath('/')).toBe('/');
        expect(normalizePluginRequestPath('/api/count?x=1&y=%2F')).toBe('/api/count?x=1&y=%2F');
        expect(normalizePluginRequestPath('/a%20b/c.js')).toBe('/a%20b/c.js');
        expect(normalizePluginRequestPath('/a..b/.well-known/x')).toBe('/a..b/.well-known/x');
    });
    it('rejects invalid_path forms', () => {
        for (const bad of [
            '', 'api', '//evil.example/x', 'http://evil.example/', '/..', '/a/../b', '/a/%2e%2e/b', '/a/%2E%2E/b', '/a/.',
            '/a\\b', '/a%5cb', '/a%5Cb', '/a%00b', '/a\u0000b', '/%2F%2Fevil.example', '/a%', '/a%zz', '/x?y=%00',
        ]) expect(normalizePluginRequestPath(bad), JSON.stringify(bad)).toBeNull();
    });
});

describe('manifestHash / privilegedHash', () => {
    it('hash vectors are stable', () => {
        const m = parse(HELLO);
        expect(pluginManifestHash(m)).toBe(HELLO_MANIFEST_HASH);
        expect(pluginPrivilegedHash(m)).toBe(HELLO_PRIVILEGED_HASH);
        expect(createHash('sha256').update(HELLO_PRIVILEGED_CANONICAL).digest('hex')).toBe(HELLO_PRIVILEGED_HASH);
    });
    it('manifestHash ignores key order, whitespace, unknown keys and explicit defaults', () => {
        const reordered = JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(HELLO).reverse())));
        expect(pluginManifestHash(parse(reordered))).toBe(HELLO_MANIFEST_HASH);
        expect(pluginManifestHash(parse(JSON.parse(JSON.stringify(HELLO, null, 4))))).toBe(HELLO_MANIFEST_HASH);
        expect(pluginManifestHash(parse(with_({ futureField: 1 })))).toBe(HELLO_MANIFEST_HASH);
        const { minApi, ...noMinApi } = HELLO;
        expect(pluginManifestHash(parse(noMinApi))).toBe(HELLO_MANIFEST_HASH);
    });
    it('manifestHash changes with any known field', () => {
        expect(pluginManifestHash(parse(with_({ version: '0.1.1' })))).not.toBe(HELLO_MANIFEST_HASH);
        expect(pluginManifestHash(parse(with_({ description: 'x' })))).not.toBe(HELLO_MANIFEST_HASH);
    });
    it('privilegedHash ignores display-only fields and permission order', () => {
        const same = [
            with_({ version: '9.9.9' }),
            with_({ description: 'changed' }),
            with_({ publisher: { name: 'Other' } }),
            with_({ sidebar: { title: 'Renamed', panel: 'main' } }),
            with_({ panels: [{ id: 'main', title: 'Other title', upstream: 'http://127.0.0.1:4310', entry: '/app' }] }),
            with_({ permissions: ['session.widget', 'decisions', 'panel', 'sidebar'] }),
            with_({ minApi: 2 }),
        ];
        for (const m of same) expect(pluginPrivilegedHash(parse(m))).toBe(HELLO_PRIVILEGED_HASH);
    });
    it('privilegedHash changes with every identity / privilege field', () => {
        const changed: [string, unknown][] = [
            ['id', with_({ id: 'hello-board2' })],
            ['name', with_({ name: 'Hello Board!' })],
            ['icon', with_({ icon: 'bot' })],
            ['icon default', (() => { const { icon, ...r } = HELLO; return r; })()],
            ['permission added', with_({ permissions: [...HELLO.permissions, 'sessions.list'] })],
            ['upstream port', with_({ panels: [{ id: 'main', title: 'Counter', upstream: 'http://127.0.0.1:4311' }] })],
            ['upstream host', with_({ panels: [{ id: 'main', title: 'Counter', upstream: 'http://[::1]:4310' }] })],
            ['panel id', with_({ panels: [{ id: 'main2', title: 'Counter', upstream: 'http://127.0.0.1:4310' }], sidebar: { title: 'Hello', panel: 'main2' } })],
            ['panel added', with_({ panels: [...HELLO.panels, { id: 'b', title: 'B', upstream: 'http://127.0.0.1:4310' }] })],
            ['callback url', with_({ callback: { url: 'http://127.0.0.1:4310/vh/other' } })],
            ['callback removed', with_({ callback: undefined })],
            ['sidebar panel', with_({ panels: [...HELLO.panels, { id: 'b', title: 'B', upstream: 'http://127.0.0.1:4310' }], sidebar: { title: 'Hello', panel: 'b' } })],
            ['sessionWidget', with_({ sessionWidget: undefined, permissions: ['sidebar', 'panel', 'decisions'] })],
        ];
        for (const [label, m] of changed) expect(pluginPrivilegedHash(parse(m)), label).not.toBe(HELLO_PRIVILEGED_HASH);
    });
});

describe('re-approval rules (§3.3)', () => {
    const approved = parse(HELLO);
    it('display-only changes apply directly', () => {
        expect(pluginUpdateNeedsApproval(approved, parse(with_({ version: '2.0.0', description: 'new' })))).toBe(false);
        expect(pluginPrivilegedDiff(approved, parse(with_({ version: '2.0.0' })))).toEqual([]);
    });
    it('reductions apply directly', () => {
        const fewer = parse({ ...HELLO, permissions: ['decisions'], sidebar: undefined, panels: undefined, sessionWidget: undefined, callback: undefined });
        const diff = pluginPrivilegedDiff(approved, fewer);
        expect(diff.length).toBeGreaterThan(0);
        expect(diff.every(c => !c.requiresApproval)).toBe(true);
        expect(pluginUpdateNeedsApproval(approved, fewer)).toBe(false);
    });
    it('additions, address and identity changes need approval', () => {
        for (const next of [
            with_({ permissions: [...HELLO.permissions, 'sessions.read'] }),
            with_({ panels: [{ id: 'main', title: 'Counter', upstream: 'http://127.0.0.1:4311' }] }),
            with_({ callback: { url: 'http://127.0.0.1:4310/other' } }),
            with_({ name: 'Hello Bored' }),
            with_({ icon: '🎉' }),
            with_({ id: 'hello-boarx' }),
        ]) expect(pluginUpdateNeedsApproval(approved, parse(next)), JSON.stringify(next).slice(0, 80)).toBe(true);
        const noCallback = parse(with_({ callback: undefined }));
        expect(pluginUpdateNeedsApproval(noCallback, approved)).toBe(true);
    });
    it('a mix of a reduction and an addition needs approval', () => {
        const next = parse(with_({ permissions: ['sidebar', 'panel', 'decisions', 'sessions.list'], sessionWidget: undefined }));
        expect(pluginUpdateNeedsApproval(approved, next)).toBe(true);
        expect(pluginPrivilegedDiff(approved, next)).toEqual(expect.arrayContaining([
            expect.objectContaining({ field: 'permission', change: 'added', ref: 'sessions.list', requiresApproval: true }),
            expect.objectContaining({ field: 'permission', change: 'removed', ref: 'session.widget', requiresApproval: false }),
        ]));
    });
});

describe('grants, states and origin', () => {
    it('sensitive permissions are not pre-checked', () => {
        expect(pluginDefaultGrants(['sidebar', 'sessions.list', 'panel', 'sessions.read', 'bogus'])).toEqual(['sidebar', 'panel']);
    });
    it('state → error code', () => {
        expect(pluginStateError('enabled')).toBeNull();
        expect(pluginStateError('update_pending')).toBeNull();
        expect(pluginStateError('pending')).toBe('plugin_pending');
        expect(pluginStateError('rejected')).toBe('plugin_rejected');
        expect(pluginStateError('disabled')).toBe('plugin_disabled');
        expect(pluginStateError('removed')).toBe('plugin_disabled');
        expect(pluginStateError('disabled_by_operator')).toBe('disabled_by_operator');
        expect(pluginStateError('something-new')).toBe('plugin_disabled');
    });
    it('error codes and HTTP statuses match the design table', () => {
        expect(PLUGIN_ERROR_STATUS).toMatchObject({
            invalid_request: 400, unauthorized: 401, permission_denied: 403, plugin_disabled: 403, plugin_rejected: 403,
            plugin_pending: 403, disabled_by_operator: 403, session_not_on_machine: 403, not_found: 404, version_conflict: 409,
            manifest_changed: 409, payload_too_large: 413, limit_exceeded: 422, rate_limited: 429, upstream_unreachable: 502,
            server_unreachable: 503, upstream_timeout: 504, invalid_path: 400, unsupported_upgrade: 501,
        });
    });
    it('per-install origin = <pluginId>-<base32(sha256(installId))[0:8]>.<pluginHost>', () => {
        expect(pluginInstallHash8('pi_test')).toBe('neozn4bo');
        expect(pluginOrigin('hello-board', 'pi_test', 'p.example.com')).toBe('https://hello-board-neozn4bo.p.example.com');
        expect(pluginInstallHash8('pi_test2')).not.toBe('neozn4bo');
        expect(pluginInstallHash8('x')).toMatch(/^[a-z2-7]{8}$/);
    });
});

describe('/plugin/v1 request schemas', () => {
    it('badge', () => {
        expect(PluginBadgePutSchema.safeParse({ count: 3, tone: 'attention', label: 'waiting' }).success).toBe(true);
        expect(PluginBadgePutSchema.safeParse({ count: null }).success).toBe(true);
        expect(PluginBadgePutSchema.safeParse({ count: 10000 }).success).toBe(false);
        expect(PluginBadgePutSchema.safeParse({ count: -1 }).success).toBe(false);
        expect(PluginBadgePutSchema.safeParse({ count: 1.5 }).success).toBe(false);
        expect(PluginBadgePutSchema.safeParse({}).success).toBe(false);
        expect(PluginBadgePutSchema.safeParse({ count: 1, label: 'x'.repeat(17) }).success).toBe(false);
        expect(pluginBadgeText(100)).toBe('99+');
        expect(pluginBadgeText(99)).toBe('99');
        expect(pluginBadgeText(0)).toBeNull();
        expect(pluginBadgeCountsGlobally({ count: 3, tone: 'attention' }, false)).toBe(3);
        expect(pluginBadgeCountsGlobally({ count: 3, tone: 'attention' }, true)).toBe(0);
        expect(pluginBadgeCountsGlobally({ count: 3, tone: 'default' }, false)).toBe(0);
    });
    it('decisions by kind', () => {
        const opts = [{ id: 'go', label: 'Continue', style: 'primary' }, { id: 'reset', label: 'Reset', style: 'danger' }];
        expect(PluginDecisionPostSchema.parse({ key: 'k', kind: 'choice', title: 'T', options: opts }).push).toBe(true);
        expect(PluginDecisionPostSchema.safeParse({ key: 'k', kind: 'choice', title: 'T' }).success).toBe(false);
        expect(PluginDecisionPostSchema.safeParse({ key: 'k', kind: 'choice', title: 'T', options: [opts[0]] }).success).toBe(false);
        expect(PluginDecisionPostSchema.safeParse({ key: 'k', kind: 'choice', title: 'T', options: [opts[0], opts[0]] }).success).toBe(false);
        expect(PluginDecisionPostSchema.safeParse({ key: 'k', kind: 'choice', title: 'T', options: [...opts, ...opts.map(o => ({ ...o, id: o.id + '2' })), { id: 'x', label: 'x' }] }).success).toBe(false);
        expect(PluginDecisionPostSchema.safeParse({ key: 'k', kind: 'input', title: 'T', input: { placeholder: 'why', maxLength: 2000, multiline: true } }).success).toBe(true);
        expect(PluginDecisionPostSchema.safeParse({ key: 'k', kind: 'input', title: 'T' }).success).toBe(false);
        expect(PluginDecisionPostSchema.safeParse({ key: 'k', kind: 'input', title: 'T', input: { maxLength: 2001 } }).success).toBe(false);
        expect(PluginDecisionPostSchema.safeParse({ key: 'k', kind: 'notice', title: 'T' }).success).toBe(true);
        expect(PluginDecisionPostSchema.safeParse({ key: 'k', kind: 'notice', title: 'T', options: opts }).success).toBe(false);
        expect(PluginDecisionPostSchema.safeParse({ key: 'k', kind: 'notice', title: 'T', input: {} }).success).toBe(false);
        expect(PluginDecisionPostSchema.safeParse({ key: 'k', kind: 'notice', title: 'x'.repeat(121) }).success).toBe(false);
        expect(PluginDecisionPostSchema.safeParse({ key: 'k'.repeat(257), kind: 'notice', title: 'T' }).success).toBe(false);
        expect(PluginDecisionPostSchema.safeParse({ key: 'k', kind: 'notice', title: 'T', bodyMd: '中'.repeat(2731) }).success).toBe(false);
        expect(PluginDecisionPostSchema.safeParse({ key: 'k', kind: 'notice', title: 'T', panelPath: '//evil' }).success).toBe(false);
        expect(PluginDecisionPostSchema.safeParse({ key: 'k', kind: 'choice', title: 'T', options: [{ id: 'Bad Id', label: 'x' }, opts[1]] }).success).toBe(false);
        expect(PluginDecisionPatchSchema.safeParse({ title: 'New', expectedVersion: 3, reopen: true }).success).toBe(true);
    });
    it('decision permissions: sessionId needs session.widget or sessions.list, panelPath needs panel', () => {
        expect(pluginDecisionMissingPermission({}, ['decisions'])).toBeNull();
        expect(pluginDecisionMissingPermission({}, ['sidebar'])).toBe('decisions');
        expect(pluginDecisionMissingPermission({ sessionId: 's' }, ['decisions'])).toBe('session.widget');
        expect(pluginDecisionMissingPermission({ sessionId: 's' }, ['decisions', 'sessions.list'])).toBeNull();
        expect(pluginDecisionMissingPermission({ sessionId: 's' }, ['decisions', 'session.widget'])).toBeNull();
        expect(pluginDecisionMissingPermission({ panelPath: '/x' }, ['decisions'])).toBe('panel');
        expect(pluginDecisionMissingPermission({ panelPath: '/x' }, ['decisions', 'panel'])).toBeNull();
    });
    it('widget', () => {
        const ok = { status: { label: 'count: 3', tone: 'info' }, text: 'hi', actions: [{ id: 'inc', label: '+1' }, { id: 'open', label: 'Open', confirm: 'Sure?' }], panelPath: '/' };
        expect(PluginWidgetPutSchema.safeParse(ok).success).toBe(true);
        expect(PluginWidgetPutSchema.safeParse({ ...ok, actions: [...ok.actions, { id: 'x', label: 'x' }] }).success).toBe(false);
        expect(PluginWidgetPutSchema.safeParse({ ...ok, status: { label: 'x', tone: 'purple' } }).success).toBe(false);
        expect(PluginWidgetPutSchema.safeParse({ ...ok, status: { label: 'x'.repeat(25), tone: 'info' } }).success).toBe(false);
        expect(PluginWidgetPutSchema.safeParse({ ...ok, text: 'x'.repeat(281) }).success).toBe(false);
        expect(PluginWidgetPutSchema.safeParse({ ...ok, actions: [{ id: 'a', label: 'x' }, { id: 'a', label: 'y' }] }).success).toBe(false);
    });
    it('op permission table', () => {
        expect(PLUGIN_OP_PERMISSION['badge.put']).toBe('sidebar');
        expect(PLUGIN_OP_PERMISSION['decision.post']).toBe('decisions');
        expect(PLUGIN_OP_PERMISSION['widget.put']).toBe('session.widget');
    });
});

describe('events', () => {
    const base = { id: 'evt_1', installId: 'pi_1', pluginId: 'hello-board', createdAt: 1, attempt: 1 };
    it('strict envelope per type', () => {
        expect(PluginEventSchema.safeParse({ ...base, type: 'decision.responded', data: { itemId: 'i', key: 'k', action: 'submit', text: 'hi', respondedAt: 1, actor: 'owner' } }).success).toBe(true);
        expect(PluginEventSchema.safeParse({ ...base, type: 'decision.responded', data: { itemId: 'i', key: 'k', action: 'hack', respondedAt: 1, actor: 'owner' } }).success).toBe(false);
        expect(PluginEventSchema.safeParse({ ...base, type: 'widget.action', data: { sessionId: 's', actionId: 'inc', at: 1, actor: 'owner' } }).success).toBe(true);
        expect(PluginEventSchema.safeParse({ ...base, type: 'install.changed', data: { state: 'enabled', grants: ['panel'], manifestHash: 'h' } }).success).toBe(true);
        expect(PluginEventSchema.safeParse({ ...base, type: 'ping', data: {} }).success).toBe(true);
        expect(PluginEventSchema.safeParse({ ...base, type: 'unknown', data: {} }).success).toBe(false);
        expect(PluginEventSchema.safeParse({ ...base, attempt: 0, type: 'ping', data: {} }).success).toBe(false);
    });
    it('lenient read keeps future types', () => {
        expect(PluginEventReadSchema.safeParse({ ...base, type: 'future.thing', data: { x: 1 } }).success).toBe(true);
    });
    it('retry schedule: 10s, 1m, 5m, 30m, 2h, then 6h, give up after 24h', () => {
        const t0 = 0;
        expect(pluginEventRetryDelayMs(1, t0, t0)).toBe(10_000);
        expect(pluginEventRetryDelayMs(2, t0, t0)).toBe(60_000);
        expect(pluginEventRetryDelayMs(5, t0, t0)).toBe(7_200_000);
        expect(pluginEventRetryDelayMs(6, t0, t0 + 3 * 3600_000)).toBe(6 * 3600_000);
        expect(pluginEventRetryDelayMs(8, t0, t0 + 20 * 3600_000)).toBeNull();
    });
});

describe('host-internal schemas', () => {
    it('approve needs a full manifest hash and known grants', () => {
        expect(PluginInstallApproveSchema.safeParse({ grants: ['sidebar'], manifestHash: HELLO_MANIFEST_HASH }).success).toBe(true);
        expect(PluginInstallApproveSchema.safeParse({ grants: ['sidebar'], manifestHash: HELLO_MANIFEST_HASH.slice(0, 8) }).success).toBe(false);
        expect(PluginInstallApproveSchema.safeParse({ grants: ['spawn'], manifestHash: HELLO_MANIFEST_HASH }).success).toBe(false);
    });
    it('install view tolerates new fields and states', () => {
        expect(PluginInstallViewSchema.safeParse({
            id: 'pi_1', machineId: 'm', pluginId: 'hello-board', name: 'Hello', icon: 'kanban', version: '0.1.0', state: 'future_state',
            grants: [], panels: [{ id: 'main', title: 'Counter' }], muted: false, origin: null, lastSeenAt: null, extra: true,
        }).success).toBe(true);
    });
    it('plugin-http carries no target address and only one body form', () => {
        const req = { reqId: 'r', installId: 'pi', panelId: 'main', method: 'GET', path: '/', headers: {} };
        expect(PluginHttpRequestSchema.safeParse(req).success).toBe(true);
        expect('upstream' in PluginHttpRequestSchema.parse({ ...req, upstream: 'http://10.0.0.1' })).toBe(false);
        expect(PluginHttpRequestSchema.safeParse({ ...req, bodyB64: '', bodyStreamId: 's' }).success).toBe(false);
        expect(PluginHttpRequestSchema.safeParse({ ...req, method: 'get' }).success).toBe(false);
    });
    it('bridge methods and permissions', () => {
        const nav = PluginBridgeRequestSchema.parse({ vh: 1, id: 1, method: 'host.navigate', params: { to: 'session', sessionId: 's' } });
        expect(pluginBridgeRequiredPermissions(nav)).toEqual(['panel', 'session.widget']);
        expect(pluginBridgeRequiredPermissions(PluginBridgeRequestSchema.parse({ vh: 1, id: 'a', method: 'host.badge.refresh' }))).toEqual(['sidebar']);
        expect(pluginBridgeRequiredPermissions(PluginBridgeRequestSchema.parse({ vh: 1, id: 'a', method: 'host.hello' }))).toEqual(['panel']);
        expect(PluginBridgeRequestSchema.safeParse({ vh: 1, id: 1, method: 'host.openExternal', params: { url: 'http://x' } }).success).toBe(false);
        expect(PluginBridgeRequestSchema.safeParse({ vh: 1, id: 1, method: 'host.openExternal', params: { url: 'javascript:alert(1)' } }).success).toBe(false);
        expect(PluginBridgeRequestSchema.safeParse({ vh: 1, id: 1, method: 'host.readToken' }).success).toBe(false);
        expect(PluginBridgeRequestSchema.safeParse({ vh: 2, id: 1, method: 'host.hello' }).success).toBe(false);
    });
});

describe('AttentionItem wire extension (B-974)', () => {
    const item = {
        id: 'a1', sessionId: null, pluginInstallId: 'pi_1', teamId: null, projectId: null, source: 'plugin', kind: 'input', key: 'k',
        title: 'T', bodyMd: null, options: null, links: null, anchor: null, firstReply: null, replyToId: null, needsOwner: true,
        state: 'open', ownerChoice: null, ownerNote: null, resolvedBy: null, resolveNote: null, repostCount: 0, createdAt: 1,
        updatedAt: 1, resolvedAt: null, pushedAt: null, version: 1,
        payload: { v: 1, type: 'plugin', pluginId: 'hello-board', pluginName: 'Hello', machineId: 'm', decisionKind: 'input', input: { maxLength: 100 }, pluginState: 'open' },
    };
    it('plugin items may have a null sessionId (any-item schema only)', () => {
        expect(AttentionItemAnySchema.safeParse(item).success).toBe(true);
        expect(AttentionItemAnySchema.safeParse({ ...item, sessionId: undefined }).success).toBe(false);
        // The session-scoped schema (old Web socket parser) rejects a sessionless plugin item.
        expect(AttentionItemSchema.safeParse(item).success).toBe(false);
        expect(AttentionItemSchema.safeParse({ ...item, sessionId: 's' }).success).toBe(true);
        const { pluginInstallId, ...older } = item;
        expect(AttentionItemSchema.safeParse({ ...older, sessionId: 's', source: 'lead', kind: 'decision' }).success).toBe(true);
        expect(isSessionAttentionItem(AttentionItemAnySchema.parse(item))).toBe(false);
        expect(isSessionAttentionItem(AttentionItemAnySchema.parse({ ...item, sessionId: 's' }))).toBe(true);
        expect(isAttentionPluginItem(item)).toBe(true);
        expect(isAttentionPluginItem({ source: 'lead', sessionId: 's', pluginInstallId: null })).toBe(false);
        expect(isAttentionPluginItem({ source: 'lead', sessionId: null })).toBe(true);
    });
    it('source plugin and kind input exist, but agents cannot post them', () => {
        expect(ATTENTION_ITEM_SOURCES).toContain('plugin');
        expect(ATTENTION_ITEM_KINDS).toContain('input');
        expect(ATTENTION_SOURCES).not.toContain('plugin');
        expect(ATTENTION_KINDS).not.toContain('input');
        const post = { sessionId: 's', source: 'lead', kind: 'report', title: 'T' };
        expect(AttentionItemPostSchema.safeParse(post).success).toBe(true);
        expect(AttentionItemPostSchema.safeParse({ ...post, source: 'plugin' }).success).toBe(false);
        expect(AttentionItemPostSchema.safeParse({ ...post, kind: 'input' }).success).toBe(false);
    });
    it('input cards wait on the owner and push like decisions', () => {
        expect(attentionItemNeedsOwner('input')).toBe(true);
        expect(attentionPushKind({ kind: 'input' })).toBe('attention');
    });
    it('owner-respond submit carries text', () => {
        expect(AttentionItemOwnerRespondSchema.safeParse({ action: 'submit', text: 'ship it' }).success).toBe(true);
        expect(AttentionItemOwnerRespondSchema.safeParse({ action: 'submit', text: '   ' }).success).toBe(false);
        expect(AttentionItemOwnerRespondSchema.safeParse({ action: 'submit', text: 'x'.repeat(2001) }).success).toBe(false);
        expect(AttentionItemOwnerRespondSchema.safeParse({ action: 'submit' }).success).toBe(false);
    });
    it('plugin payload strict write, lenient read', () => {
        expect(AttentionPluginPayloadSchema.safeParse(item.payload).success).toBe(true);
        expect(AttentionPluginPayloadSchema.safeParse({ ...item.payload, decisionKind: 'other' }).success).toBe(false);
        expect(parsePluginPayload({ ...item.payload, decisionKind: 'other', extra: 1 })?.pluginName).toBe('Hello');
        expect(parsePluginPayload({ v: 1, type: 'select', items: [] })).toBeNull();
    });
    it('?include=plugin opt-in', () => {
        expect(AttentionItemListQuerySchema.parse({ include: 'plugin' }).include).toBe('plugin');
        expect(attentionQueryIncludesPlugin('plugin')).toBe(true);
        expect(attentionQueryIncludesPlugin('foo, plugin')).toBe(true);
        expect(attentionQueryIncludesPlugin('plugins')).toBe(false);
        expect(attentionQueryIncludesPlugin(undefined)).toBe(false);
    });
});

describe('r4 plugin-op contract', () => {
    it('op names match §5.10', () => {
        expect([...PLUGIN_OPS].sort()).toEqual([
            'audit.sensitiveRead', 'badge.put', 'decision.delete', 'decision.list', 'decision.patch', 'decision.post',
            'events.ack', 'events.pull', 'events.result', 'info', 'install.disable', 'install.remove', 'install.sync',
            'widget.delete', 'widget.get', 'widget.put',
        ]);
        for (const op of PLUGIN_OPS) {
            expect(PLUGIN_OP_PAYLOAD_SCHEMAS[op], op).toBeDefined();
            expect(PLUGIN_OP_RESULT_SCHEMAS[op], op).toBeDefined();
        }
    });
    it('installId is null exactly for install.sync', () => {
        expect(PluginOpRequestSchema.safeParse({ installId: null, op: 'install.sync', payload: {}, requestId: 'r' }).success).toBe(true);
        expect(PluginOpRequestSchema.safeParse({ installId: 'pi', op: 'install.sync', payload: {}, requestId: 'r' }).success).toBe(false);
        expect(PluginOpRequestSchema.safeParse({ installId: null, op: 'badge.put', payload: {}, requestId: 'r' }).success).toBe(false);
        expect(PluginOpRequestSchema.safeParse({ installId: 'pi', op: 'badge.put', payload: { count: 1 }, requestId: 'r' }).success).toBe(true);
        expect(PluginOpRequestSchema.safeParse({ installId: 'pi', op: 'sessions.audit', payload: {}, requestId: 'r' }).success).toBe(false);
    });
    it('payloads carry route params', () => {
        expect(PLUGIN_OP_PAYLOAD_SCHEMAS['decision.patch'].safeParse({ key: 'k', title: 'T' }).success).toBe(true);
        expect(PLUGIN_OP_PAYLOAD_SCHEMAS['decision.patch'].safeParse({ title: 'T' }).success).toBe(false);
        expect(PLUGIN_OP_PAYLOAD_SCHEMAS['widget.put'].safeParse({ sessionId: 's', status: { label: 'x', tone: 'info' } }).success).toBe(true);
        expect(PLUGIN_OP_PAYLOAD_SCHEMAS['widget.put'].safeParse({ status: { label: 'x', tone: 'info' } }).success).toBe(false);
        expect(PLUGIN_OP_PAYLOAD_SCHEMAS['events.result'].safeParse({ eventId: 'e', status: 'delivered', attempt: 1 }).success).toBe(true);
        expect(PLUGIN_OP_PAYLOAD_SCHEMAS['events.result'].safeParse({ eventId: 'e', status: 'maybe', attempt: 1 }).success).toBe(false);
        expect(PLUGIN_OP_PAYLOAD_SCHEMAS['audit.sensitiveRead'].safeParse({ permission: 'sessions.read', sessionIds: ['s'] }).success).toBe(true);
        expect(PLUGIN_OP_PAYLOAD_SCHEMAS['audit.sensitiveRead'].safeParse({ permission: 'panel', sessionIds: [] }).success).toBe(false);
    });
    it('permissions per op with payload extras', () => {
        const all = ['sidebar', 'panel', 'decisions', 'session.widget', 'sessions.list', 'sessions.read'];
        for (const op of PLUGIN_OPS) expect(pluginOpMissingPermission(op, { permission: 'sessions.read' }, all), op).toBeNull();
        expect(pluginOpMissingPermission('badge.put', {}, ['panel'])).toBe('sidebar');
        expect(pluginOpMissingPermission('decision.post', { sessionId: 's' }, ['decisions'])).toBe('session.widget');
        expect(pluginOpMissingPermission('decision.patch', { panelPath: '/x' }, ['decisions'])).toBe('panel');
        expect(pluginOpMissingPermission('widget.put', { panelPath: '/x' }, ['session.widget'])).toBe('panel');
        expect(pluginOpMissingPermission('widget.put', {}, ['session.widget'])).toBeNull();
        expect(pluginOpMissingPermission('audit.sensitiveRead', { permission: 'sessions.read' }, ['sessions.list'])).toBe('sessions.read');
        expect(pluginOpMissingPermission('audit.sensitiveRead', { permission: 'sessions.list' }, ['sessions.list'])).toBeNull();
        expect(pluginOpMissingPermission('audit.sensitiveRead', { permission: 'panel' }, all)).toBe('sessions.read');
        expect(pluginOpMissingPermission('events.pull', {}, [])).toBeNull();
        expect(pluginOpMissingPermission('info', {}, [])).toBeNull();
    });
    it('ack shapes', () => {
        expect(PluginOpAckSchema.safeParse({ ok: true, result: { badge: null } }).success).toBe(true);
        const err = pluginOpError('permission_denied', 'no', { permission: 'sidebar' });
        expect(err).toEqual({ ok: false, status: 403, error: 'permission_denied', message: 'no', permission: 'sidebar' });
        expect(PluginOpAckSchema.safeParse(err).success).toBe(true);
        expect(PluginOpAckSchema.safeParse({ ok: false, error: 'x' }).success).toBe(false);
    });
    it('install.sync item', () => {
        expect(PluginInstallSyncItemSchema.safeParse({ id: 'pi', pluginId: 'p', state: 'enabled', grants: ['panel'], manifest: HELLO, manifestHash: HELLO_MANIFEST_HASH, pending: false }).success).toBe(true);
        expect(PluginInstallSyncItemSchema.safeParse({ id: 'pi', pluginId: 'p', state: 'pending', grants: [], manifest: null, manifestHash: null, pending: true, disabledBy: 'operator' }).success).toBe(true);
        expect(PluginInstallSyncItemSchema.safeParse({ id: 'pi', pluginId: 'p', state: 'enabled', grants: [], manifest: null, manifestHash: null }).success).toBe(false);
    });
});

describe('r1 host views', () => {
    it('pendingDiff lists every changed field and marks privileged ones', () => {
        const next = parse(with_({ version: '0.2.0', panels: [{ id: 'main', title: 'Counter 2', upstream: 'http://127.0.0.1:4311' }], permissions: ['sidebar', 'panel', 'decisions', 'session.widget', 'sessions.list'] }));
        const d = pluginPendingDiff(parse(HELLO), next);
        expect(d.manifestHash).toBe(pluginManifestHash(next));
        expect(d.version).toBe('0.2.0');
        expect(d.changes).toEqual([
            { field: 'panels.main.title', before: 'Counter', after: 'Counter 2', privileged: false },
            { field: 'panels.main.upstream', before: 'http://127.0.0.1:4310', after: 'http://127.0.0.1:4311', privileged: true },
            { field: 'version', before: '0.1.0', after: '0.2.0', privileged: false },
        ]);
        expect(d.addedPermissions).toEqual(['sessions.list']);
        expect(d.removedPermissions).toEqual([]);
        const first = pluginPendingDiff(null, parse(HELLO));
        expect(first.addedPermissions).toEqual(['decisions', 'panel', 'session.widget', 'sidebar']);
        expect(first.changes.find(c => c.field === 'callback.url')).toEqual({ field: 'callback.url', before: null, after: 'http://127.0.0.1:4310/vh/callback', privileged: true });
        const fewer = pluginPendingDiff(parse(HELLO), parse(with_({ permissions: ['sidebar', 'panel', 'decisions'], sessionWidget: undefined })));
        expect(fewer.removedPermissions).toEqual(['session.widget']);
        expect(fewer.changes).toEqual([{ field: 'sessionWidget', before: true, after: false, privileged: true }]);
    });
    it('install detail, audit and widget socket payloads', () => {
        const view = { id: 'pi', machineId: 'm', pluginId: 'p', name: 'P', icon: 'bot', version: '1.0.0', state: 'pending', grants: [], panels: [], muted: false, origin: null, lastSeenAt: null };
        expect(PluginInstallDetailSchema.safeParse({ install: view, review: { manifest: HELLO, manifestHash: HELLO_MANIFEST_HASH, submittedAt: 1, machineId: 'm' } }).success).toBe(true);
        expect(PluginInstallDetailSchema.safeParse({ install: { ...view, muted: undefined }, review: { manifest: HELLO, manifestHash: 'h', submittedAt: 1, machineId: 'm' } }).success).toBe(false);
        expect(PluginAuditListResponseSchema.safeParse({ entries: [{ id: 'a', at: 1, actor: 'plugin', action: 'sessions.read', detail: '2 sessions' }], sensitiveReads24h: 2 }).success).toBe(true);
        expect(UpdatePluginWidgetBodySchema.safeParse({ t: 'plugin-widget', installId: 'pi', sessionId: 's', removed: true }).success).toBe(true);
        expect(UpdatePluginWidgetBodySchema.safeParse({ t: 'plugin-widget', installId: 'pi', sessionId: 's', status: { label: 'x', tone: 'info' }, actions: [], version: 1, updatedAt: 1 }).success).toBe(true);
        expect(UpdatePluginWidgetBodySchema.safeParse({ t: 'plugin-widget', sessionId: 's', status: { label: 'x', tone: 'info' }, actions: [], version: 1, updatedAt: 1 }).success).toBe(false);
    });
    it('r3 panel paths allow ?query and #fragment', () => {
        for (const ok of ['/', '/board?case=12', '/board#c-12', '/a?x=1#y/z']) expect(isPluginPanelPath(ok), ok).toBe(true);
        for (const bad of ['#x', 'board', '//evil#x', '/a/../b#x', '/a#x y', '/a#x\\y', '/a#\u0000']) expect(isPluginPanelPath(bad), bad).toBe(false);
        expect(PluginDecisionPostSchema.safeParse({ key: 'k', kind: 'notice', title: 'T', panelPath: '/board#c-12' }).success).toBe(true);
    });
    it('owner-system and session links', () => {
        expect(ATTENTION_ITEM_SOURCES).toContain('owner-system');
        expect(ATTENTION_SOURCES).not.toContain('owner-system');
        expect(AttentionItemPostSchema.safeParse({ sessionId: 's', source: 'owner-system', kind: 'report', title: 'T' }).success).toBe(false);
        expect(ATTENTION_ITEM_LINK_TYPES).toContain('session');
        expect(ATTENTION_LINK_TYPES).not.toContain('session');
        expect(AttentionItemLinkSchema.safeParse({ type: 'session', ref: 's' }).success).toBe(true);
        expect(attentionLinkedSessionId({ links: [{ type: 'pr', ref: '1' }, { type: 'session', ref: 'sess_1' }] })).toBe('sess_1');
        expect(attentionLinkedSessionId({ links: null })).toBeNull();
        expect(isAttentionPluginItem({ source: 'owner-system', sessionId: null })).toBe(true);
    });
});

describe('B-974f install review card payload', () => {
    it('reads a v1 plugin-review payload and nothing else', () => {
        const p = { v: 1, type: 'plugin-review', pluginName: 'Hello Board', update: true };
        expect(AttentionPluginReviewPayloadSchema.parse(p)).toEqual(p);
        expect(parsePluginReviewPayload(p)).toEqual(p);
        expect(parsePluginReviewPayload({ ...p, extra: 1, update: 'x' })).toEqual({ ...p, update: false });
        expect(parsePluginReviewPayload({ v: 1, type: 'plugin', pluginName: 'x' })).toBeNull();
        expect(parsePluginReviewPayload({ v: 1, type: 'plugin-review', pluginName: '' })).toBeNull();
        expect(parsePluginReviewPayload(null)).toBeNull();
        expect(parsePluginPayload(p)).toBeNull();
    });
});
