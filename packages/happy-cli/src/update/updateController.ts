import type { CliUpdateState } from '@/api/types';
import { compareExactVersions } from './cliUpdate';

export interface UpdateControllerDependencies {
    policy: () => Promise<CliUpdateState | null>;
    enabled: () => Promise<boolean>;
    idle: () => boolean;
    install: (version: string) => Promise<number | null>;
    publish: (state: CliUpdateState) => void;
    now?: () => number;
}
/** Serializes install attempts, retains terminal outcomes, and never retries a failure without a user action. */
export function createUpdateController(deps: UpdateControllerDependencies) {
    let policy: CliUpdateState | null = null;
    let outcome: CliUpdateState['autoUpdate'] = null;
    let running = false;
    let checking = false;
    let lastPublished = '';
    const now = deps.now ?? Date.now;
    function publish(state: string, version: string | null, detail?: string) {
        if (!policy) return;
        const fingerprint = JSON.stringify([policy.checkedAt, state, version, detail]);
        if (fingerprint === lastPublished) return;
        lastPublished = fingerprint;
        outcome = { state, version, detail, at: now() };
        deps.publish({ ...policy, retrySupported: true, autoUpdate: outcome });
    }
    async function evaluate() {
        if (!policy || running) return;
        const target = policy.autoUpdateVersion ?? null;
        if (outcome?.version === target && ['failed', 'installed'].includes(outcome.state)) {
            const fingerprint = JSON.stringify([policy.checkedAt, outcome.state, outcome.version, outcome.detail]);
            if (fingerprint !== lastPublished) {
                lastPublished = fingerprint;
                deps.publish({ ...policy, retrySupported: true, autoUpdate: outcome });
            }
            return;
        }
        // Busy waits may be reconsidered without re-fetching, but never after policy expiry.
        if (now() - policy.checkedAt > 65 * 60_000) { publish('policy_stale', target); return; }
        if (!await deps.enabled()) { publish('disabled', target); return; }
        if (running) return;
        if (!target) { publish('unapproved', null); return; }
        const order = compareExactVersions(policy.currentVersion, target);
        if (order !== -1) { publish(order === null ? 'policy_stale' : 'current', target); return; }
        if (!deps.idle()) { publish('waiting_idle', target); return; }
        // Set before awaiting install. No RPC or timer can create a second install.
        running = true;
        publish('installing', target);
        try {
            const code = await deps.install(target);
            publish(code === 0 ? 'installed' : 'failed', target, code === 0 ? undefined : 'npm_install_failed');
        } catch {
            publish('failed', target, 'npm_install_failed');
        } finally { running = false; }
    }
    async function refresh() {
        if (checking || running) return;
        checking = true;
        try {
            const next = await deps.policy();
            if (!next) return;
            policy = next;
            await evaluate();
        } finally { checking = false; }
    }
    async function retry(version: unknown): Promise<{ accepted: true } | { error: string }> {
        if (checking || running) return { error: 'update_in_progress' };
        if (typeof version !== 'string' || outcome?.state !== 'failed' || outcome.version !== version) {
            return { error: 'no_matching_failed_update' };
        }
        checking = true;
        try {
            // Explicit retry always rechecks authorization; no stale recommendation may trigger an install.
            const next = await deps.policy();
            if (!next || next.autoUpdateVersion !== version || now() - next.checkedAt > 65 * 60_000) {
                return { error: 'update_policy_changed_or_unavailable' };
            }
            if (!await deps.enabled()) return { error: 'auto_update_disabled' };
            policy = next;
            outcome = null;
            publish('waiting_idle', version);
            // Acknowledge receipt, not installation. Installation may take minutes.
            setTimeout(() => { void evaluate().catch(() => publish('policy_stale', version)); }, 0);
            return { accepted: true };
        } finally { checking = false; }
    }
    return { refresh, retry, tick: evaluate, isRunning: () => running };
}
