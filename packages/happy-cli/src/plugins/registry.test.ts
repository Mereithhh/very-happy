import { statSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { applyServerInstall } from './store';
import { checkAccess, checkInstallState } from './registry';
import { manifestHash } from './manifest';
import { installApproved, registryFor, sampleManifest, tempHome } from './testFixtures';

describe('B-974c store, token auth and permission gate', () => {
    let cleanup = () => {};
    afterEach(() => cleanup());

    it('credentials appear only after approval, with 0700 dir and 0600 files', () => {
        const t = tempHome(); cleanup = t.cleanup;
        const { store } = registryFor(t.home);
        const m = sampleManifest();
        store.writePending(m.id, m);
        store.writeInstall(m.id, { installId: 'pi_1', pluginId: m.id, state: 'pending', grants: [], approvedManifestHash: null, updatedAt: 1 });
        // A server reply that is still pending / rejected / approves another hash creates nothing.
        applyServerInstall(store, m.id, { installId: 'pi_1', state: 'pending', grants: [], manifestHash: null });
        applyServerInstall(store, m.id, { installId: 'pi_1', state: 'rejected', grants: [], manifestHash: manifestHash(m) });
        applyServerInstall(store, m.id, { installId: 'pi_1', state: 'enabled', grants: ['sidebar'], manifestHash: 'f'.repeat(64) });
        expect(store.readToken(m.id)).toBeNull();
        expect(store.readSecret(m.id)).toBeNull();
        expect(store.readApprovedManifest(m.id)).toBeNull();
        expect(store.readInstall(m.id)?.grants).toEqual([]);

        const r = applyServerInstall(store, m.id, { installId: 'pi_1', state: 'enabled', grants: ['sidebar', 'panel', 'sessions.read'], manifestHash: manifestHash(m) });
        expect(r.promoted).toBe(true);
        expect(r.credentialsCreated).toBe(true);
        // A grant the manifest never asked for is dropped.
        expect(r.record.grants).toEqual(['sidebar', 'panel']);
        expect(store.readToken(m.id)).toMatch(/^vhp_/);
        expect(statSync(store.dir(m.id)).mode & 0o777).toBe(0o700);
        expect(statSync(store.tokenFile(m.id)).mode & 0o777).toBe(0o600);
        expect(statSync(store.secretFile(m.id)).mode & 0o777).toBe(0o600);
        expect(statSync(store.dir(m.id) + '/install.json').mode & 0o777).toBe(0o600);
    });

    it('authenticates only the exact token of an approved install', () => {
        const t = tempHome(); cleanup = t.cleanup;
        const { store, registry } = registryFor(t.home);
        const a = installApproved(store, sampleManifest());
        const b = installApproved(store, sampleManifest({ id: 'other-plugin' }), { installId: 'pi_b' });
        registry.reload();
        expect(registry.authenticate(`Bearer ${a.token}`)?.record.installId).toBe('pi_hello-board');
        expect(registry.authenticate(`Bearer ${b.token}`)?.record.installId).toBe('pi_b');
        for (const bad of [undefined, '', 'Bearer ', `bearer ${a.token}`, `Bearer ${a.token}x`, `Bearer ${a.token.slice(0, -1)}`, a.token, `Basic ${a.token}`]) {
            expect(registry.authenticate(bad)).toBeNull();
        }
        // Rotation: the old token stops working at the next reload.
        store.rotateCredentials('hello-board');
        registry.reload();
        expect(registry.authenticate(`Bearer ${a.token}`)).toBeNull();
        expect(registry.authenticate(`Bearer ${store.readToken('hello-board')}`)).not.toBeNull();
    });

    it('a truncated or hand-written short token file never authenticates', () => {
        const t = tempHome(); cleanup = t.cleanup;
        const { store, registry } = registryFor(t.home);
        installApproved(store, sampleManifest());
        writeFileSync(store.tokenFile('hello-board'), 'x');
        registry.reload();
        expect(registry.authenticate('Bearer x')).toBeNull();
    });

    it('a pending install has no usable token even if a token file exists', () => {
        const t = tempHome(); cleanup = t.cleanup;
        const { store, registry } = registryFor(t.home);
        const m = sampleManifest();
        store.writePending(m.id, m);
        store.writeInstall(m.id, { installId: 'pi_1', pluginId: m.id, state: 'pending', grants: [], approvedManifestHash: null, updatedAt: 1 });
        store.ensureCredentials(m.id); // planted by someone else
        registry.reload();
        expect(registry.authenticate(`Bearer ${store.readToken(m.id)}`)).toBeNull();
    });

    it('state gate and current grants', () => {
        const t = tempHome(); cleanup = t.cleanup;
        const { store, registry } = registryFor(t.home);
        installApproved(store, sampleManifest(), { grants: ['sidebar', 'decisions'] });
        registry.reload();
        const e = registry.get('hello-board')!;
        expect(checkAccess(e, { allOf: ['sidebar'] })).toBeNull();
        expect(checkAccess(e, { allOf: ['panel'] })).toMatchObject({ status: 403, error: 'permission_denied', permission: 'panel' });
        expect(checkAccess(e, { allOf: ['decisions'], anyOf: ['session.widget', 'sessions.list'] })).toMatchObject({ error: 'permission_denied' });
        expect(checkAccess(e, { allOf: ['decisions'], anyOf: ['sidebar', 'sessions.list'] })).toBeNull();

        for (const [state, error] of [['disabled', 'plugin_disabled'], ['rejected', 'plugin_rejected'], ['disabled_by_operator', 'disabled_by_operator'], ['pending', 'plugin_pending']] as const) {
            applyServerInstall(store, 'hello-board', { installId: 'pi_hello-board', state, grants: ['sidebar'], manifestHash: null });
            registry.reload();
            expect(checkAccess(registry.get('hello-board')!, { allOf: ['sidebar'] })).toMatchObject({ status: 403, error });
        }
        // update_pending keeps the old approval working (§3.3).
        applyServerInstall(store, 'hello-board', { installId: 'pi_hello-board', state: 'update_pending', grants: ['sidebar'], manifestHash: null });
        registry.reload();
        expect(checkInstallState(registry.get('hello-board')!)).toBeNull();
        // Local disable wins over the server state.
        store.writeInstall('hello-board', { ...store.readInstall('hello-board')!, localDisabled: true });
        registry.reload();
        expect(checkAccess(registry.get('hello-board')!, { allOf: ['sidebar'] })).toMatchObject({ error: 'plugin_disabled' });
    });
});
