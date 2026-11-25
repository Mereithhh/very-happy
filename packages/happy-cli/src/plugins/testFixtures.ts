/** B-974c test helpers: a temp HAPPY_HOME_DIR with installed plugins. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginStore, applyServerInstall, type ServerInstallState } from './store';
import { PluginManifestSchema, manifestHash, type PluginManifest, type PluginPermission } from './manifest';
import { PluginRegistry } from './registry';

export function tempHome(): { home: string; cleanup: () => void } {
    const home = mkdtempSync(join(tmpdir(), 'vh-plugins-'));
    return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

export function sampleManifest(overrides: Partial<PluginManifest> & Record<string, unknown> = {}): PluginManifest {
    return PluginManifestSchema.parse({
        schema: 'vh-plugin/v1',
        id: 'hello-board',
        name: 'Hello Board',
        version: '0.1.0',
        icon: 'kanban',
        permissions: ['sidebar', 'panel', 'decisions', 'session.widget'],
        sidebar: { title: 'Hello', panel: 'main' },
        panels: [{ id: 'main', title: 'Counter', upstream: 'http://127.0.0.1:4310', entry: '/' }],
        callback: { url: 'http://127.0.0.1:4310/vh/callback' },
        sessionWidget: true,
        ...overrides,
    });
}

/** Install `manifest` as approved with `grants` (default: everything it asks for) and return the token. */
export function installApproved(store: PluginStore, manifest: PluginManifest, opts: { installId?: string; grants?: PluginPermission[]; state?: ServerInstallState } = {}): { installId: string; token: string; secret: string } {
    const installId = opts.installId ?? `pi_${manifest.id}`;
    store.writePending(manifest.id, manifest);
    store.writeInstall(manifest.id, { installId, pluginId: manifest.id, state: 'pending', grants: [], approvedManifestHash: null, updatedAt: Date.now() });
    applyServerInstall(store, manifest.id, { installId, state: 'enabled', grants: opts.grants ?? manifest.permissions, manifestHash: manifestHash(manifest) });
    if (opts.state && opts.state !== 'enabled') applyServerInstall(store, manifest.id, { installId, state: opts.state, grants: opts.grants ?? manifest.permissions, manifestHash: manifestHash(manifest) });
    return { installId, token: store.readToken(manifest.id)!, secret: store.readSecret(manifest.id)! };
}

export function registryFor(home: string): { store: PluginStore; registry: PluginRegistry } {
    const store = new PluginStore(home);
    return { store, registry: new PluginRegistry(store) };
}
