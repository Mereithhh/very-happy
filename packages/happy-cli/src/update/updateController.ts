import type { CliUpdateState } from '@/api/types';
import { compareExactVersions } from './cliUpdate';

export interface UpdateControllerDependencies {
    policy: () => Promise<CliUpdateState | null>;
    enabled: () => Promise<boolean>;
    idle: () => boolean;
    install: (version: string) => Promise<number | null | 'blocked'>;
    publish: (state: CliUpdateState) => void;
    now?: () => number;
}
/** Serializes install attempts, retains terminal outcomes, and never retries a failure without a user action. */
export function createUpdateController(deps: UpdateControllerDependencies) {
    let policy: CliUpdateState | null = null;
    let outcome: CliUpdateState['autoUpdate'] = null;
    let running = false;
    let manualVersion: string | null = null;
    let operation: 'refresh' | 'retry' | 'request' | 'tick' | 'handover' | null = null;
    let blocked = false;
    let handoverHold: CliUpdateState['handoverHold'];
    let lastPublished = '';
    const now = deps.now ?? Date.now;
    function validManualTarget(next: CliUpdateState, version: string) {
        return version === next.recommendedVersion
            && Number.isFinite(next.checkedAt) && now() - next.checkedAt <= 65 * 60_000 && next.checkedAt <= now() + 60_000
            && compareExactVersions(next.currentVersion, version) === -1
            && (!next.minimumVersion || [0, 1].includes(compareExactVersions(version, next.minimumVersion) ?? -1));
    }
    function publish(state: string, version: string | null, detail?: string) {
        if (!policy) return;
        const fingerprint = JSON.stringify([policy.checkedAt, state, version, detail, manualVersion]);
        if (fingerprint === lastPublished) return;
        lastPublished = fingerprint;
        outcome = { state, version, detail, at: now(), ...(manualVersion ? { source: 'manual' } : {}) };
        deps.publish({ ...policy, retrySupported: !blocked, manualUpdateSupported: !blocked, handoverHold, autoUpdate: outcome });
    }
    async function evaluate() {
        if (!policy || running) return;
        const target = manualVersion ?? policy.autoUpdateVersion ?? null;
        if (outcome?.version === target && ['failed', 'installed'].includes(outcome.state)) {
            const fingerprint = JSON.stringify([policy.checkedAt, outcome.state, outcome.version, outcome.detail, manualVersion]);
            if (fingerprint !== lastPublished) {
                lastPublished = fingerprint;
                deps.publish({ ...policy, retrySupported: !blocked, manualUpdateSupported: !blocked, handoverHold, autoUpdate: outcome });
            }
            return;
        }
        // Busy waits may be reconsidered without re-fetching, but never after policy expiry.
        if (now() - policy.checkedAt > 65 * 60_000) { publish('policy_stale', target); return; }
        if (!manualVersion && !await deps.enabled()) { publish('disabled', target); return; }
        if (running) return;
        if (now() - policy.checkedAt > 65 * 60_000) { publish('policy_stale', target); return; }
        if (!target) { publish('unapproved', null); return; }
        const order = compareExactVersions(policy.currentVersion, target);
        if (order !== -1) { publish(order === null ? 'policy_stale' : 'current', target); return; }
        if (!deps.idle()) { publish('waiting_idle', target); return; }
        // Set before awaiting install. No RPC or timer can create a second install.
        running = true;
        publish('installing', target);
        try {
            const code = await deps.install(target);
            blocked = code === 'blocked';
            publish(blocked ? 'manual_required' : code === 0 ? 'installed' : 'failed', target,
                blocked ? 'installer_termination_unconfirmed' : code === 0 ? undefined : 'npm_install_failed');
        } catch {
            publish('failed', target, 'npm_install_failed');
        } finally { running = false; }
    }
    async function tick() {
        if (operation || blocked) return;
        operation = 'tick';
        try { await evaluate(); } finally { operation = null; }
    }
    async function refresh() {
        if (operation || blocked) return;
        operation = 'refresh';
        try {
            const next = await deps.policy();
            if (!next) return;
            if (manualVersion && !validManualTarget(next, manualVersion)) manualVersion = null;
            policy = next;
            await evaluate();
        } finally { operation = null; }
    }
    async function retry(version: unknown): Promise<{ accepted: true } | { error: string }> {
        if (operation || blocked) return { error: blocked ? 'manual_recovery_required' : 'update_in_progress' };
        if (typeof version !== 'string' || outcome?.state !== 'failed' || outcome.version !== version) {
            return { error: 'no_matching_failed_update' };
        }
        operation = 'retry';
        try {
            const next = await deps.policy();
            if (!next || (manualVersion ? !validManualTarget(next, version) : next.autoUpdateVersion !== version || now() - next.checkedAt > 65 * 60_000)) {
                return { error: 'update_policy_changed_or_unavailable' };
            }
            if (!manualVersion && !await deps.enabled()) return { error: 'auto_update_disabled' };
            policy = next;
            outcome = null;
            handoverHold = null;
            publish('waiting_idle', version);
            setTimeout(() => { void tick().catch(() => publish('policy_stale', version)); }, 0);
            return { accepted: true };
        } finally { operation = null; }
    }
    async function request(version: unknown): Promise<{ accepted: true } | { error: string }> {
        if (operation || blocked) return { error: blocked ? 'manual_recovery_required' : 'update_in_progress' };
        operation = 'request';
        try {
            const next = await deps.policy();
            // A second click can discover revocation before the periodic refresh.
            // Do not leave the earlier queued intent armed in that case.
            if (next && manualVersion && !validManualTarget(next, manualVersion)) {
                manualVersion = null;
                policy = next;
                publish('policy_stale', null);
            }
            if (!next || typeof version !== 'string' || !validManualTarget(next, version)) {
                return { error: 'update_policy_changed_or_unavailable' };
            }
            if (outcome?.version === version && (outcome.state === 'installed' || (manualVersion === version && outcome.state === 'waiting_idle'))) {
                policy = next;
                publish(outcome.state, version, outcome.detail);
                return { accepted: true };
            }
            policy = next;
            manualVersion = version;
            outcome = null;
            handoverHold = null;
            publish('waiting_idle', version);
            setTimeout(() => { void tick().catch(() => publish('policy_stale', version)); }, 0);
            return { accepted: true };
        } finally { operation = null; }
    }
    /** Includes preflight and the complete ownership-release window. */
    async function withHandover(task: () => Promise<void>) {
        if (operation || blocked) return;
        operation = 'handover';
        try { await task(); } finally { operation = null; }
    }
    function holdHandover(reason: string) {
        handoverHold = { reason, at: now() };
        publish('failed', manualVersion ?? policy?.autoUpdateVersion ?? null, 'handover_preflight_failed');
    }
    return { refresh, retry, request, tick, withHandover, holdHandover, isRunning: () => running };
}
