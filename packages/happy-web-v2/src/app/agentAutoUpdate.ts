/**
 * agentAutoUpdate (B-894) — the machine's「自动更新 agent」 (default off): with
 * it on, the daemon installs a newer Codex CLI by itself once no Codex turn is
 * running (harness installer, bounded retries). Published by the daemon in
 * `daemonState.agentAutoUpdate`; trusted only when written by THIS daemon run
 * (same rule as every capability).
 *
 * Model gates are NOT here: which Codex version a model needs is
 * modelSupportPolicy's (B-893). This only says "your Codex is behind the
 * registry" and offers the update.
 *
 * Pure rules only (no store / network imports).
 */
import { readAgentVersions } from './agentVersions';

export interface AgentAutoUpdateStatus {
    harness: string;
    target: string;
    /** installing | installed | failed | gave-up (open: unknown = failed). */
    state: string;
    detail?: string;
    attempts: number;
    at: number;
}

export interface MachineAgentAutoUpdate {
    enabled: boolean;
    status: Record<string, AgentAutoUpdateStatus>;
}

export function readMachineAgentAutoUpdate(daemonState: unknown): MachineAgentAutoUpdate | null {
    const state = daemonState as { startedAt?: unknown; agentAutoUpdate?: { enabled?: unknown; rpcAvailable?: unknown; detectedAt?: unknown; status?: unknown } } | null | undefined;
    const au = state?.agentAutoUpdate;
    if (!au || au.rpcAvailable !== true || typeof au.enabled !== 'boolean' || typeof au.detectedAt !== 'number') return null;
    if (typeof state?.startedAt === 'number' && au.detectedAt < state.startedAt) return null;
    const status: Record<string, AgentAutoUpdateStatus> = {};
    if (au.status && typeof au.status === 'object') {
        for (const [id, raw] of Object.entries(au.status as Record<string, unknown>)) {
            const s = raw as Partial<AgentAutoUpdateStatus> | null;
            if (!s || typeof s.state !== 'string' || typeof s.target !== 'string' || typeof s.at !== 'number') continue;
            status[id] = {
                harness: typeof s.harness === 'string' ? s.harness : id,
                target: s.target, state: s.state, at: s.at,
                attempts: typeof s.attempts === 'number' ? s.attempts : 1,
                ...(typeof s.detail === 'string' ? { detail: s.detail } : {}),
            };
        }
    }
    return { enabled: au.enabled, status };
}

/**
 * New-session notice「Codex vX 较旧 · 更新」 (deliberately no "models unavailable":
 * API-provider accounts run every model on older Codex; per-model gates are
 * modelSupportPolicy / B-893's). Shown when the machine's
 * (fresh) version check says Codex has an update, and the daemon will not do
 * it by itself (switch off or not supported). Null otherwise.
 */
export function codexOutdatedNotice(daemonState: unknown, now = Date.now()): { installed: string; latest: string } | null {
    const versions = readAgentVersions(daemonState, now);
    if (!versions || versions.stale) return null;
    const codex = versions.agents.find((a) => a.id === 'codex');
    if (!codex || codex.status !== 'update-available' || !codex.installed || !codex.latest) return null;
    if (readMachineAgentAutoUpdate(daemonState)?.enabled === true) return null;
    return { installed: codex.installed, latest: codex.latest };
}
