/**
 * B-974c: the daemon's in-memory view of installed plugins, and the two
 * security gates of `/plugin/v1`: who is calling (token → install, fixed-time
 * comparison) and may it do this right now (state + current grants).
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { PluginManifest, PluginPermission } from './manifest';
import { PluginStore, effectiveState, isLiveState, type EffectiveInstallState, type InstallRecord } from './store';

export type PluginEntry = {
    id: string;
    record: InstallRecord;
    /** The approved manifest; null until the first approval. */
    manifest: PluginManifest | null;
    state: EffectiveInstallState;
    secret: string | null;
    tokenDigest: Buffer | null;
};

const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest();
const EMPTY_DIGEST = digest('');

export class PluginRegistry {
    private entries = new Map<string, PluginEntry>();

    constructor(readonly store: PluginStore) {}

    reload(): PluginEntry[] {
        const next = new Map<string, PluginEntry>();
        for (const id of this.store.listIds()) {
            const record = this.store.readInstall(id);
            if (!record) continue;
            const manifest = record.approvedManifestHash ? this.store.readApprovedManifest(id) : null;
            const token = manifest ? this.store.readToken(id) : null;
            next.set(id, {
                id,
                record,
                manifest,
                state: effectiveState(record),
                secret: manifest ? this.store.readSecret(id) : null,
                tokenDigest: token && token.length >= 36 ? digest(token) : null,
            });
        }
        this.entries = next;
        return [...next.values()];
    }

    list(): PluginEntry[] { return [...this.entries.values()]; }
    get(id: string): PluginEntry | undefined { return this.entries.get(id); }
    byInstallId(installId: string): PluginEntry | undefined {
        for (const e of this.entries.values()) if (e.record.installId === installId) return e;
        return undefined;
    }

    /**
     * `Authorization: Bearer vhp_…` → install. Every candidate is compared as a
     * sha256 digest with timingSafeEqual and the loop never exits early, so the
     * time taken does not depend on which (if any) token matched or how long
     * the presented value is.
     */
    authenticate(authorization: string | undefined): PluginEntry | null {
        const prefix = 'Bearer ';
        const candidate = typeof authorization === 'string' && authorization.startsWith(prefix) ? authorization.slice(prefix.length) : '';
        const candidateDigest = digest(candidate);
        let found: PluginEntry | null = null;
        for (const entry of this.entries.values()) {
            const expected = entry.tokenDigest ?? EMPTY_DIGEST;
            const equal = timingSafeEqual(expected, candidateDigest);
            if (equal && entry.tokenDigest !== null && candidate.length > 0 && found === null) found = entry;
        }
        return found;
    }
}

export type AccessDenied = { status: number; error: string; message: string; permission?: PluginPermission };

const STATE_ERRORS: Record<string, AccessDenied> = {
    pending: { status: 403, error: 'plugin_pending', message: 'this plugin is waiting for approval on the web' },
    rejected: { status: 403, error: 'plugin_rejected', message: 'the owner rejected this plugin' },
    disabled: { status: 403, error: 'plugin_disabled', message: 'this plugin is disabled' },
    disabled_by_operator: { status: 403, error: 'disabled_by_operator', message: 'this plugin was disabled by the service operator' },
};

/** May this install use its approval right now? */
export function checkInstallState(entry: PluginEntry): AccessDenied | null {
    if (isLiveState(entry.state) && entry.manifest) return null;
    return STATE_ERRORS[entry.state] ?? STATE_ERRORS.pending;
}

/** A permission counts only when granted now AND asked for by the approved manifest. */
export function hasPermission(entry: PluginEntry, permission: PluginPermission): boolean {
    return entry.manifest !== null && entry.record.grants.includes(permission) && entry.manifest.permissions.includes(permission);
}

/**
 * State gate, then permissions: every one of `allOf`, and at least one of
 * `anyOf` when given. Evaluated per request against the registry's current
 * record — revoking a grant takes effect at the next call.
 */
export function checkAccess(entry: PluginEntry, need: { allOf?: PluginPermission[]; anyOf?: PluginPermission[] }): AccessDenied | null {
    const stateDenied = checkInstallState(entry);
    if (stateDenied) return stateDenied;
    for (const permission of need.allOf ?? []) {
        if (!hasPermission(entry, permission)) return { status: 403, error: 'permission_denied', message: `needs the "${permission}" permission`, permission };
    }
    if (need.anyOf && need.anyOf.length > 0 && !need.anyOf.some((p) => hasPermission(entry, p))) {
        return { status: 403, error: 'permission_denied', message: `needs one of: ${need.anyOf.join(', ')}`, permission: need.anyOf[0] };
    }
    return null;
}
