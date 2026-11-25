/**
 * B-974c: per-plugin state and credentials under `<HAPPY_HOME_DIR>/plugins/<id>/`
 * (DESIGN §2.2). Directories are 0700, files 0600. `token` and `secret` are
 * written only once the install has been approved (`applyServerInstall`).
 *
 *   pending.json   manifest waiting for approval (add / update with a privileged change)
 *   manifest.json  the approved manifest — the only one forwarding and permissions read
 *   install.json   installId, server state, grants, local disable
 *   token, secret  plugin bearer token / callback HMAC key (approved installs only)
 *   runtime.json   { api, installId, state } for the plugin process
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { PRIVATE_DIRECTORY_MODE, writePrivateFileSync } from '@/utils/secureFiles';
import { PluginManifestSchema, manifestHash, privilegedHash, type PluginManifest, PLUGIN_PERMISSIONS, type PluginPermission } from './manifest';
import { createPluginSecretFileText, createPluginToken } from './signing';

export const SERVER_INSTALL_STATES = ['pending', 'enabled', 'update_pending', 'rejected', 'disabled', 'disabled_by_operator', 'removed'] as const;
export type ServerInstallState = typeof SERVER_INSTALL_STATES[number];
/** What the plugin sees: the server state, or `disabled` when turned off on this machine. */
export type EffectiveInstallState = ServerInstallState;

const InstallRecordSchema = z.object({
    installId: z.string().min(1).max(128),
    pluginId: z.string(),
    state: z.enum(SERVER_INSTALL_STATES),
    grants: z.array(z.enum(PLUGIN_PERMISSIONS)),
    /** manifestHash of manifest.json as the server approved it. */
    approvedManifestHash: z.string().nullable(),
    reviewUrl: z.string().optional(),
    /** Where `plugin add` read the manifest (re-read by `plugin update`). */
    source: z.string().max(1024).optional(),
    localDisabled: z.boolean().optional(),
    localDisabledReason: z.string().max(500).optional(),
    updatedAt: z.number(),
});
export type InstallRecord = z.infer<typeof InstallRecordSchema>;

const PendingSchema = z.object({
    manifest: z.unknown(),
    manifestHash: z.string(),
    privilegedHash: z.string(),
    submittedAt: z.number(),
});
export type PendingManifest = { manifest: PluginManifest; manifestHash: string; privilegedHash: string; submittedAt: number };

const PLUGIN_ID = /^[a-z0-9][a-z0-9-]{1,31}$/;

export function pluginsRoot(home: string): string { return join(home, 'plugins'); }
export function pluginDir(home: string, id: string): string {
    if (!PLUGIN_ID.test(id)) throw new Error(`invalid plugin id "${id}"`);
    return join(pluginsRoot(home), id);
}

function ensureDir(path: string): void {
    mkdirSync(path, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    try { chmodSync(path, PRIVATE_DIRECTORY_MODE); } catch (e) { if (process.platform !== 'win32') throw e; }
}

function writeAtomic(path: string, data: string): void {
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    writePrivateFileSync(tmp, data);
    renameSync(tmp, path);
}

function readJson(path: string): unknown {
    try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

export class PluginStore {
    constructor(readonly home: string) {}

    dir(id: string): string { return pluginDir(this.home, id); }

    ensurePluginDir(id: string): string {
        ensureDir(pluginsRoot(this.home));
        const dir = this.dir(id);
        ensureDir(dir);
        return dir;
    }

    listIds(): string[] {
        const root = pluginsRoot(this.home);
        if (!existsSync(root)) return [];
        return readdirSync(root).filter((name) => PLUGIN_ID.test(name) && (() => { try { return statSync(join(root, name)).isDirectory(); } catch { return false; } })()).sort();
    }

    readInstall(id: string): InstallRecord | null {
        const parsed = InstallRecordSchema.safeParse(readJson(join(this.dir(id), 'install.json')));
        return parsed.success ? parsed.data : null;
    }

    writeInstall(id: string, record: InstallRecord): void {
        this.ensurePluginDir(id);
        writeAtomic(join(this.dir(id), 'install.json'), JSON.stringify(InstallRecordSchema.parse(record), null, 2));
    }

    readPending(id: string): PendingManifest | null {
        const parsed = PendingSchema.safeParse(readJson(join(this.dir(id), 'pending.json')));
        if (!parsed.success) return null;
        const manifest = PluginManifestSchema.safeParse(parsed.data.manifest);
        return manifest.success ? { ...parsed.data, manifest: manifest.data } : null;
    }

    writePending(id: string, manifest: PluginManifest): PendingManifest {
        this.ensurePluginDir(id);
        const pending = { manifest, manifestHash: manifestHash(manifest), privilegedHash: privilegedHash(manifest), submittedAt: Date.now() };
        writeAtomic(join(this.dir(id), 'pending.json'), JSON.stringify(pending, null, 2));
        return pending;
    }

    clearPending(id: string): void { rmSync(join(this.dir(id), 'pending.json'), { force: true }); }

    readApprovedManifest(id: string): PluginManifest | null {
        const parsed = PluginManifestSchema.safeParse(readJson(join(this.dir(id), 'manifest.json')));
        return parsed.success ? parsed.data : null;
    }

    writeApprovedManifest(id: string, manifest: PluginManifest): void {
        this.ensurePluginDir(id);
        writeAtomic(join(this.dir(id), 'manifest.json'), JSON.stringify(manifest, null, 2));
    }

    tokenFile(id: string): string { return join(this.dir(id), 'token'); }
    secretFile(id: string): string { return join(this.dir(id), 'secret'); }
    runtimeFile(id: string): string { return join(this.dir(id), 'runtime.json'); }

    readToken(id: string): string | null {
        try { const t = readFileSync(this.tokenFile(id), 'utf8').trim(); return t.length > 0 ? t : null; } catch { return null; }
    }

    /** Raw secret file text (decode with `readPluginSecretKey`). */
    readSecret(id: string): string | null {
        try { const s = readFileSync(this.secretFile(id), 'utf8'); return s.trim().length > 0 ? s : null; } catch { return null; }
    }

    /** Creates token + secret when missing. Callers check approval first. */
    ensureCredentials(id: string): boolean {
        let created = false;
        if (!this.readToken(id)) { writeAtomic(this.tokenFile(id), createPluginToken()); created = true; }
        if (!this.readSecret(id)) { writeAtomic(this.secretFile(id), createPluginSecretFileText()); created = true; }
        return created;
    }

    /** `plugin rotate`: both values are replaced; the old ones stop working at the next daemon reload. */
    rotateCredentials(id: string): void {
        writeAtomic(this.tokenFile(id), createPluginToken());
        writeAtomic(this.secretFile(id), createPluginSecretFileText());
    }

    deleteCredentials(id: string): void {
        rmSync(this.tokenFile(id), { force: true });
        rmSync(this.secretFile(id), { force: true });
    }

    writeRuntime(id: string, runtime: { api: string | null; installId: string; state: EffectiveInstallState }): void {
        this.ensurePluginDir(id);
        writeAtomic(this.runtimeFile(id), JSON.stringify(runtime, null, 2));
    }

    readFileJson(id: string, name: string): unknown { return readJson(join(this.dir(id), name)); }
    writeFileJson(id: string, name: string, value: unknown): void {
        this.ensurePluginDir(id);
        writeAtomic(join(this.dir(id), name), JSON.stringify(value));
    }

    remove(id: string): void { rmSync(this.dir(id), { recursive: true, force: true }); }
}

export function effectiveState(record: InstallRecord): EffectiveInstallState {
    return record.localDisabled ? 'disabled' : record.state;
}

/** States in which the approved manifest and grants are live (§3.3: update_pending keeps the old approval). */
export function isLiveState(state: EffectiveInstallState): boolean {
    return state === 'enabled' || state === 'update_pending';
}

export type ServerInstallUpdate = { installId: string; state: ServerInstallState; grants: PluginPermission[]; manifestHash: string | null };

/**
 * Fold the server's view of an install into local state (`plugin-install-changed`
 * RPC, `installs.sync`, `plugin add/update` replies). A pending manifest is
 * promoted only when the server approved exactly that hash, and credentials are
 * created only for an approved, live install.
 */
export function applyServerInstall(store: PluginStore, id: string, update: ServerInstallUpdate): { record: InstallRecord; promoted: boolean; credentialsCreated: boolean } {
    const current = store.readInstall(id);
    if (current && current.installId !== update.installId) throw new Error(`install id mismatch for ${id}`);
    const pending = store.readPending(id);
    let promoted = false;
    let approvedHash = current?.approvedManifestHash ?? null;
    if (pending && update.manifestHash && pending.manifestHash === update.manifestHash && (update.state === 'enabled' || update.state === 'disabled')) {
        store.writeApprovedManifest(id, pending.manifest);
        store.clearPending(id);
        approvedHash = pending.manifestHash;
        promoted = true;
    }
    const approved = approvedHash ? store.readApprovedManifest(id) : null;
    // Grants can never exceed what the approved manifest asks for.
    const grants = approved ? update.grants.filter((g) => approved.permissions.includes(g)) : [];
    const record: InstallRecord = {
        installId: update.installId,
        pluginId: id,
        state: update.state,
        grants,
        approvedManifestHash: approved ? approvedHash : null,
        ...(current?.reviewUrl ? { reviewUrl: current.reviewUrl } : {}),
        ...(current?.source ? { source: current.source } : {}),
        ...(current?.localDisabled ? { localDisabled: true } : {}),
        ...(current?.localDisabledReason ? { localDisabledReason: current.localDisabledReason } : {}),
        updatedAt: Date.now(),
    };
    store.writeInstall(id, record);
    const credentialsCreated = approved !== null && isLiveState(update.state) ? store.ensureCredentials(id) : false;
    return { record, promoted, credentialsCreated };
}
