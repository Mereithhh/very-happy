import { describe, expect, it } from 'vitest';
import { operatorBlock, pluginFrameAncestors, pluginHostConfig, pluginLabelOfHost, pluginsEnabledFor } from './pluginConfig';
import {
    effectiveGrants, installBlock, installView, nextAttemptAt, originLabelFor, pendingDiff, PluginError, requireUsable, requiresApproval, validateGrants,
    createWindowLimiter, EVENT_GIVE_UP_MS, type InstallRow,
} from './pluginRules';
import { parsePluginLoopbackUrl, pluginManifestHash as manifestHash, PluginDecisionPostSchema, PluginManifestSchema, pluginPrivilegedHash as privilegedHash, type PluginManifest } from '@slopus/happy-wire';
const isLoopbackUrl = (v: string, withPath: boolean) => parsePluginLoopbackUrl(v, withPath) !== null;

const base = {
    schema: 'vh-plugin/v1', id: 'hello-board', name: 'Hello Board', version: '0.1.0', icon: 'kanban',
    permissions: ['sidebar', 'panel', 'decisions', 'session.widget'],
    sidebar: { title: 'Hello', panel: 'main' },
    panels: [{ id: 'main', title: '计数器', upstream: 'http://127.0.0.1:4310', entry: '/' }],
    callback: { url: 'http://127.0.0.1:4310/vh/callback' },
    sessionWidget: true,
};
const parse = (m: unknown) => PluginManifestSchema.parse(m);

function install(over: Partial<InstallRow> = {}): InstallRow {
    const manifest = parse(base);
    return {
        id: 'pi_x', accountId: 'a', machineId: 'm', pluginId: 'hello-board', state: 'enabled', manifest, manifestHash: manifestHash(manifest), privilegedHash: privilegedHash(manifest),
        pendingManifest: null, pendingManifestHash: null, pendingSubmittedAt: null, grants: ['sidebar', 'panel', 'decisions', 'session.widget'], badge: null, muted: false,
        disabledBy: null, disabledReason: null, frameEpoch: 0, originLabel: 'hello-board-abcdefgh', lastSeenAt: null, approvedAt: null, version: 1, createdAt: new Date(), updatedAt: new Date(),
        ...over,
    };
}

describe('manifest (vh-plugin/v1)', () => {
    it('accepts the design example and fills defaults', () => {
        const m = parse(base);
        expect(m.minApi).toBe(1);
        expect(m.panels?.[0].entry).toBe('/');
    });

    it('upstream / callback are loopback IP literals with a port ≥ 1024 only', () => {
        for (const ok of ['http://127.0.0.1:4310', 'http://[::1]:65535']) expect(isLoopbackUrl(ok, false), ok).toBe(true);
        for (const bad of ['http://localhost:4310', 'https://127.0.0.1:4310', 'http://127.0.0.1:80', 'http://127.0.0.1:4310/x', 'http://u:p@127.0.0.1:4310', 'http://127.0.0.2:4310', 'http://127.0.0.1', 'http://127.0.0.1:4310?x=1', 'http://169.254.169.254:8080', 'http://0x7f000001:4310']) {
            expect(isLoopbackUrl(bad, false), bad).toBe(false);
        }
        expect(isLoopbackUrl('http://127.0.0.1:4310/vh/callback', true)).toBe(true);
        expect(isLoopbackUrl('http://127.0.0.1:4310@evil.example/vh', true)).toBe(false);
        for (const bad of ['http://10.0.0.1:4310/vh', 'http://localhost:4310/vh', 'http://169.254.169.254:8080/latest']) expect(isLoopbackUrl(bad, true), bad).toBe(false);
    });

    it('refuses an unknown schema, SVG icons, and permissions without their declarations', () => {
        expect(PluginManifestSchema.safeParse({ ...base, schema: 'vh-plugin/v2' }).success).toBe(false);
        expect(PluginManifestSchema.safeParse({ ...base, icon: '<svg/>' }).success).toBe(false);
        expect(PluginManifestSchema.safeParse({ ...base, icon: '🧩' }).success).toBe(true);
        expect(PluginManifestSchema.safeParse({ ...base, sidebar: undefined }).success).toBe(false);
        expect(PluginManifestSchema.safeParse({ ...base, sessionWidget: false }).success).toBe(false);
        expect(PluginManifestSchema.safeParse({ ...base, sidebar: { title: 'x', panel: 'nope' } }).success).toBe(false);
        expect(PluginManifestSchema.safeParse({ ...base, name: 'a\nb' }).success).toBe(false);
    });

    it('hashes are key-order independent; the privileged hash ignores cosmetic fields', () => {
        const a = parse(base);
        const b = parse({ ...base, version: '0.2.0', description: 'new' });
        expect(manifestHash(a)).not.toBe(manifestHash(b));
        expect(privilegedHash(a)).toBe(privilegedHash(b));
        expect(privilegedHash(a)).not.toBe(privilegedHash(parse({ ...base, name: 'Hello Bored' })));
    });
});

describe('re-approval rules (§3.3)', () => {
    const a = parse(base);
    it('needs the owner for added privilege or a changed identity / address', () => {
        expect(requiresApproval(a, parse({ ...base, permissions: [...base.permissions, 'sessions.list'] }))).toBe(true);
        expect(requiresApproval(a, parse({ ...base, panels: [{ ...base.panels[0], upstream: 'http://127.0.0.1:4311' }] }))).toBe(true);
        expect(requiresApproval(a, parse({ ...base, callback: { url: 'http://127.0.0.1:4310/other' } }))).toBe(true);
        expect(requiresApproval(a, parse({ ...base, name: 'Other' }))).toBe(true);
        expect(requiresApproval(a, parse({ ...base, icon: 'bot' }))).toBe(true);
        expect(requiresApproval(a, parse({ ...base, panels: [...base.panels, { id: 'two', title: '2', upstream: 'http://127.0.0.1:4312' }] }))).toBe(true);
    });
    it('applies reductions and cosmetic edits at once', () => {
        expect(requiresApproval(a, parse({ ...base, version: '9.9.9', description: 'x', sidebar: { title: 'Renamed', panel: 'main' } }))).toBe(false);
        expect(requiresApproval(a, parse({ ...base, permissions: ['sidebar', 'panel'], sessionWidget: undefined, callback: undefined }))).toBe(false);
        expect(requiresApproval(a, parse({ ...base, panels: [{ ...base.panels[0], title: 'new title', entry: '/x' }] }))).toBe(false);
    });
    it('diff marks privileged fields and permission changes', () => {
        const next = parse({ ...base, version: '0.2.0', permissions: [...base.permissions, 'sessions.read'] });
        const d = pendingDiff(a, next);
        expect(d.addedPermissions).toEqual(['sessions.read']);
        expect(d.changes.find(c => c.field === 'version')?.privileged).toBe(false);
        // List / socket views keep the change but never the address.
        const moved = parse({ ...base, panels: [{ ...base.panels[0], upstream: 'http://127.0.0.1:4999' }], callback: { url: 'http://127.0.0.1:4999/cb' } });
        const full = pendingDiff(a, moved);
        const redacted = pendingDiff(a, moved, false);
        expect(JSON.stringify(full)).toContain('4999');
        expect(JSON.stringify(redacted)).not.toContain('4999');
        expect(redacted.changes.map(c => c.field)).toEqual(full.changes.map(c => c.field));
    });
});

describe('install state and grants', () => {
    it('maps states to the §5.1 codes; update_pending keeps working', () => {
        expect(installBlock(install(), {})).toBeNull();
        expect(installBlock(install({ state: 'update_pending' }), {})).toBeNull();
        expect(installBlock(install({ state: 'pending' }), {})).toBe('plugin_pending');
        expect(installBlock(install({ state: 'rejected' }), {})).toBe('plugin_rejected');
        expect(installBlock(install({ state: 'disabled' }), {})).toBe('plugin_disabled');
    });

    it('kill switch: VH_PLUGINS_DISABLED and the denylist (id or manifest hash) win over enabled', () => {
        expect(installBlock(install(), { VH_PLUGINS_DISABLED: '1' })).toBe('disabled_by_operator');
        expect(installView(install(), null, { VH_PLUGINS_DISABLED: '1' })).toMatchObject({ state: 'disabled_by_operator', disabledBy: 'operator', stateReason: 'all_disabled' });
        expect(installBlock(install(), { VH_PLUGIN_DENYLIST: 'other, HELLO-BOARD' })).toBe('disabled_by_operator');
        const row = install();
        expect(installBlock(row, { VH_PLUGIN_DENYLIST: row.manifestHash! })).toBe('disabled_by_operator');
        expect(operatorBlock(row, { VH_PLUGIN_DENYLIST: 'nope' })).toBeNull();
    });

    it('effective grants = granted ∩ declared by the approved manifest', () => {
        const row = install({ grants: ['sidebar', 'sessions.read'] });
        expect(effectiveGrants(row)).toEqual(['sidebar']);
        expect(() => requireUsable(row, 'panel', {})).toThrowError(expect.objectContaining({ code: 'permission_denied', details: { permission: 'panel' } }));
        expect(() => requireUsable(install({ state: 'disabled' }), 'sidebar', {})).toThrowError(expect.objectContaining({ code: 'plugin_disabled' }));
        expect(() => requireUsable(row, 'sidebar', {})).not.toThrow();
    });

    it('grants the owner gives must be declared', () => {
        const m = parse(base);
        expect(validateGrants(['panel', 'sidebar'], m)).toEqual(['sidebar', 'panel']);
        expect(() => validateGrants(['sessions.read'], m)).toThrow(PluginError);
    });

    it('origin label: plugin id + 8 base32 chars of sha256(installId) (wire), distinct per install', () => {
        const l1 = originLabelFor('hello-board', 'pi_a');
        expect(l1).toMatch(/^hello-board-[a-z2-7]{8}$/);
        expect(originLabelFor('hello-board', 'pi_b')).not.toBe(l1);
    });
});

describe('event retry schedule (§5.5)', () => {
    it('10 s, 1 min, 5 min, 30 min, 2 h, then 6 h; gives up after 24 h', () => {
        const t0 = 1_000_000;
        expect(nextAttemptAt(t0, 1, t0)! - t0).toBe(10_000);
        expect(nextAttemptAt(t0, 2, t0)! - t0).toBe(60_000);
        expect(nextAttemptAt(t0, 5, t0)! - t0).toBe(2 * 3600_000);
        expect(nextAttemptAt(t0, 6, t0)! - t0).toBe(6 * 3600_000);
        expect(nextAttemptAt(t0, 9, t0 + EVENT_GIVE_UP_MS - 3600_000)).toBeNull();
    });
});

describe('config', () => {
    it('feature switch: global or per-account canary', () => {
        expect(pluginsEnabledFor('a', {})).toBe(false);
        expect(pluginsEnabledFor('a', { VH_PLUGINS_ENABLED: '1' })).toBe(true);
        expect(pluginsEnabledFor('a', { VH_PLUGINS_ENABLED_ACCOUNTS: 'b, a' })).toBe(true);
        expect(pluginsEnabledFor('c', { VH_PLUGINS_ENABLED_ACCOUNTS: 'b, a' })).toBe(false);
    });
    it('Host dispatch: only one label directly under VH_PLUGIN_HOST', () => {
        const config = pluginHostConfig({ VH_PLUGIN_HOST: 'p.example.com' });
        expect(pluginLabelOfHost('hello-board-abcdefgh.p.example.com', config)).toBe('hello-board-abcdefgh');
        expect(pluginLabelOfHost('HELLO-board-abcdefgh.P.example.com', config)).toBe('hello-board-abcdefgh');
        expect(pluginLabelOfHost('p.example.com', config)).toBeNull();
        expect(pluginLabelOfHost('a.b.p.example.com', config)).toBeNull();
        expect(pluginLabelOfHost('x.p.example.com.evil.com', config)).toBeNull();
        expect(pluginLabelOfHost('veryhappy.example.com', config)).toBeNull();
        expect(pluginLabelOfHost('x.p.example.com', null)).toBeNull();
        expect(pluginHostConfig({ VH_PLUGIN_HOST: 'bad host' })).toBeNull();
    });
    it('frame-ancestors: configured origins, else PUBLIC_URL, else the ticket origin', () => {
        expect(pluginFrameAncestors('https://web.example', { VH_PLUGIN_WEB_ORIGINS: 'https://a.example, https://b.example/x' })).toEqual(['https://a.example', 'https://b.example']);
        expect(pluginFrameAncestors('https://web.example', { PUBLIC_URL: 'https://pub.example/' })).toEqual(['https://pub.example']);
        expect(pluginFrameAncestors('https://web.example', {})).toEqual(['https://web.example']);
        expect(pluginFrameAncestors(null, {})).toEqual([]);
    });
});

describe('decision payload', () => {
    it('choice needs 2–4 options; input needs input; nothing else carries them', () => {
        const d = { key: 'k', title: 't' };
        expect(PluginDecisionPostSchema.safeParse({ ...d, kind: 'choice', options: [{ id: 'a', label: 'A' }] }).success).toBe(false);
        expect(PluginDecisionPostSchema.safeParse({ ...d, kind: 'choice', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }).success).toBe(true);
        expect(PluginDecisionPostSchema.safeParse({ ...d, kind: 'input' }).success).toBe(false);
        expect(PluginDecisionPostSchema.safeParse({ ...d, kind: 'input', input: {} }).success).toBe(true);
        expect(PluginDecisionPostSchema.safeParse({ ...d, kind: 'notice', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }).success).toBe(false);
        expect(PluginDecisionPostSchema.safeParse({ ...d, kind: 'notice', bodyMd: 'x'.repeat(8 * 1024 + 1) }).success).toBe(false);
    });
});

describe('window limiter', () => {
    it('allows `limit` per window, then reports the wait', () => {
        let t = 0;
        const l = createWindowLimiter(2, 1000, () => t);
        expect(l.take('a').ok).toBe(true);
        expect(l.take('a').ok).toBe(true);
        expect(l.take('a')).toEqual({ ok: false, retryAfterMs: 1000 });
        expect(l.take('b').ok).toBe(true);
        t = 1000;
        expect(l.take('a').ok).toBe(true);
    });
});

void ({} as PluginManifest);
