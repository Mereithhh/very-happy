import {
    pluginEventRetryDelayMs, pluginOriginLabel, pluginPendingDiff, pluginStateError, pluginUpdateNeedsApproval, PLUGIN_PERMISSIONS,
    type PluginInstallView, type PluginManifest, type PluginPendingDiff, type PluginPermission,
} from '@slopus/happy-wire';
import { randomBytes } from 'node:crypto';
import { operatorBlock, pluginOrigin, type PluginHostConfig } from './pluginConfig';

/** Pure B-974 plugin rules (design B-973 §3, §5), testable without a database. Hashes, diffs and origins come from the wire. */

export class PluginError extends Error {
    constructor(public code: string, public status = 400, public details?: Record<string, unknown>) { super(code); }
}
export function requirePlugin(condition: unknown, code: string, status = 400, details?: Record<string, unknown>): asserts condition {
    if (!condition) throw new PluginError(code, status, details);
}

export interface InstallRow {
    id: string; accountId: string; machineId: string; pluginId: string; state: string;
    manifest: unknown; manifestHash: string | null; privilegedHash: string | null;
    pendingManifest: unknown; pendingManifestHash: string | null; pendingSubmittedAt: Date | null;
    grants: string[]; badge: unknown; muted: boolean; disabledBy: string | null; disabledReason: string | null;
    frameEpoch: number; originLabel: string; lastSeenAt: Date | null; approvedAt: Date | null; version: number;
    createdAt: Date; updatedAt: Date;
}

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
export function newInstallId(): string {
    return `pi_${[...randomBytes(26)].map(b => BASE32[b & 31]).join('')}`;
}

/** `<pluginId>-<h8>` (wire `pluginOriginLabel`, the same function the Web and the daemon use). */
export function originLabelFor(pluginId: string, installId: string): string {
    return pluginOriginLabel(pluginId, installId);
}

/** The state shown and enforced: the operator's switch (`VH_PLUGINS_DISABLED`, denylist) overrides the stored one. */
export function effectiveState(install: Pick<InstallRow, 'state' | 'pluginId' | 'manifestHash' | 'pendingManifestHash'>, env: NodeJS.ProcessEnv = process.env): string {
    return operatorBlock(install, env) ? 'disabled_by_operator' : install.state;
}

/**
 * Why this install may not act right now, as the §5.1 error code; null when it may.
 * `update_pending` keeps working on the old approval (§3.3). The operator's switch wins over everything.
 */
export function installBlock(install: Pick<InstallRow, 'state' | 'pluginId' | 'manifestHash' | 'pendingManifestHash'>, env: NodeJS.ProcessEnv = process.env): string | null {
    return pluginStateError(effectiveState(install, env));
}

/** Effective grants: granted AND still declared by the approved manifest (a manifest that dropped one revokes it). */
export function effectiveGrants(install: Pick<InstallRow, 'grants' | 'manifest'>): PluginPermission[] {
    const declared = new Set((install.manifest as PluginManifest | null)?.permissions ?? []);
    return PLUGIN_PERMISSIONS.filter(p => install.grants.includes(p) && declared.has(p));
}

export function hasGrant(install: Pick<InstallRow, 'grants' | 'manifest'>, permission: PluginPermission): boolean {
    return effectiveGrants(install).includes(permission);
}

/** Refuses with the install-state code first, then `permission_denied { permission }`. Read fresh every call (no cache). */
export function requireUsable(install: InstallRow, permission?: PluginPermission | null, env: NodeJS.ProcessEnv = process.env): void {
    const block = installBlock(install, env);
    if (block) throw new PluginError(block, 403);
    if (permission && !hasGrant(install, permission)) throw new PluginError('permission_denied', 403, { permission });
}

/** Grants the owner may give: only permissions the pending manifest declares. */
export function validateGrants(requested: readonly string[], manifest: PluginManifest): PluginPermission[] {
    const declared = new Set<string>(manifest.permissions);
    for (const g of requested) requirePlugin(declared.has(g), 'invalid_request', 400, { issues: [{ path: ['grants'], message: `not requested by the plugin: ${g}` }] });
    return PLUGIN_PERMISSIONS.filter(p => requested.includes(p));
}

/** Whether going from the approved manifest to `next` needs the owner (design §3.3; wire `pluginUpdateNeedsApproval`). */
export function requiresApproval(approved: PluginManifest, next: PluginManifest): boolean {
    return pluginUpdateNeedsApproval(approved, next);
}

const ADDRESS_FIELD = /^(panels\.[^.]+\.upstream|callback\.url)$/;

/**
 * r1 `pendingDiff` (wire `pluginPendingDiff`). `withAddresses: false` (list and socket views) keeps every
 * changed field but blanks the upstream / callback URL values — those are only on the detail route.
 */
export function pendingDiff(approved: PluginManifest | null, pending: PluginManifest, withAddresses = true): PluginPendingDiff {
    const diff = pluginPendingDiff(approved, pending);
    if (withAddresses) return diff;
    return { ...diff, changes: diff.changes.map(c => ADDRESS_FIELD.test(c.field) ? { ...c, before: c.before === null ? null : '', after: c.after === null ? null : '' } : c) };
}

// ─── Machine op → permission: wire `pluginOpMissingPermission` (r4). ─────────

// ─── Event redelivery (design §5.5) ──────────────────────────────────────────

export const EVENT_GIVE_UP_MS = 24 * 3600_000;

/** When to try again after `attempts` failed deliveries, or null to give up (24 h after the event was made). */
export function nextAttemptAt(createdAt: number, attempts: number, now: number): number | null {
    const delay = pluginEventRetryDelayMs(attempts, createdAt, now);
    return delay === null ? null : now + delay;
}

// ─── Views ───────────────────────────────────────────────────────────────────

/** `PluginInstallView` (wire). List / socket view: never the upstream or callback addresses unless `withAddresses` (detail route). */
export function installView(row: InstallRow, host: PluginHostConfig | null, env: NodeJS.ProcessEnv = process.env, withAddresses = false): PluginInstallView {
    const approved = row.manifest as PluginManifest | null;
    const pending = row.pendingManifest as PluginManifest | null;
    const shown = approved ?? pending;
    const state = effectiveState(row, env);
    const operator = state === 'disabled_by_operator' && row.state !== 'disabled_by_operator';
    return {
        id: row.id, machineId: row.machineId, pluginId: row.pluginId,
        name: shown?.name ?? row.pluginId, icon: shown?.icon ?? 'puzzle', version: shown?.version ?? '',
        description: shown?.description ?? null, publisher: shown?.publisher ?? null,
        state,
        stateReason: operator ? operatorBlock(row, env) : row.disabledReason,
        grants: effectiveGrants(row),
        requested: [...(shown?.permissions ?? [])],
        ...(row.manifestHash ? { manifestHash: row.manifestHash } : {}),
        pendingManifestHash: row.pendingManifestHash,
        pendingDiff: pending ? pendingDiff(approved, pending, withAddresses) : null,
        sidebar: approved?.sidebar ? { title: approved.sidebar.title, panel: approved.sidebar.panel } : null,
        panels: (approved?.panels ?? []).map(p => ({ id: p.id, title: p.title })),
        sessionWidget: approved?.sessionWidget === true,
        hasCallback: !!approved?.callback,
        badge: (row.badge as PluginInstallView['badge']) ?? null,
        muted: row.muted,
        origin: host ? pluginOrigin(row.originLabel, host) : null,
        lastSeenAt: row.lastSeenAt ? row.lastSeenAt.getTime() : null,
        createdAt: row.createdAt.getTime(), updatedAt: row.updatedAt.getTime(),
        ...(operator ? { disabledBy: 'operator' } : row.disabledBy ? { disabledBy: row.disabledBy } : {}),
    };
}

// ─── Rate limits (per replica, in memory; design §5) ─────────────────────────

/** Fixed-window counter: `take(key)` false once `limit` calls happened in the current window. */
export function createWindowLimiter(limit: number, windowMs: number, now: () => number = Date.now) {
    const windows = new Map<string, { start: number; count: number }>();
    return {
        take(key: string): { ok: true } | { ok: false; retryAfterMs: number } {
            const t = now();
            let w = windows.get(key);
            if (!w || t - w.start >= windowMs) {
                w = { start: t, count: 0 };
                windows.set(key, w);
                if (windows.size > 50_000) for (const [k, v] of windows) if (t - v.start >= windowMs) windows.delete(k);
            }
            if (w.count >= limit) return { ok: false, retryAfterMs: w.start + windowMs - t };
            w.count++;
            return { ok: true };
        },
    };
}
