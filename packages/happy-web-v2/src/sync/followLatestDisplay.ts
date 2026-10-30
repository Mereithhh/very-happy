import { LATEST_MODEL_MODE, MACHINE_CONFIG_AGENTS, type LatestModelResolution, type LatestModelTable } from '@slopus/happy-wire';
import type { ModelMode } from '@/components/modelModeOptions';
import type { Metadata } from './storageTypes';
import { normalizeAgentKey, resolveLatestForAgent } from './agentDefaults';

/**
 * B-844b: how "follow latest" is shown — one picker entry instead of the
 * machine default ("X (default)") next to the same model marked latest, and a
 * Settings value resolved per machine by the function sends use
 * (resolveLatestForAgent with the session's own metadata), not the table head.
 */
export type FollowLatestState =
    /** Runs the newest model of the tier the wrapper proves it can run. */
    | { kind: 'latest'; model: string; label: string | null }
    /** The machine's own agent config pins a model (Codex/Gemini) — it wins. */
    | { kind: 'machineConfig'; model: string }
    /** A live wrapper proves nothing newer (old CLI: no configuredModel / no
     *  capability): nothing is sent, the machine default runs. */
    | { kind: 'machineDefault' }
    /** No session or machine to resolve against. */
    | { kind: 'dependsOnMachine' };

export function followLatestState(resolution: LatestModelResolution, resolvedForSession: boolean): FollowLatestState {
    if (resolution.configured) return { kind: 'machineConfig', model: resolution.configured };
    if (resolution.model) return { kind: 'latest', model: resolution.model, label: resolution.label };
    return resolvedForSession ? { kind: 'machineDefault' } : { kind: 'dependsOnMachine' };
}

export function sameFollowLatestState(a: FollowLatestState, b: FollowLatestState): boolean {
    if (a.kind !== b.kind) return false;
    return !('model' in a) || a.model === (b as typeof a).model;
}

/**
 * Picker list for an agent whose default is "follow latest": a leading
 * `latest` entry replaces the machine-default entry and the model it resolves
 * to (both were the same model under two names). The model stays listed when
 * it is the explicit selection (a pin), and so does `default` — named, never
 * the raw "default model" key — for Claude (it means "follow /model", which
 * follow-latest overrides) or when it is selected.
 */
export function withFollowLatestOption(options: readonly ModelMode[], input: {
    flavor: string | null | undefined;
    follow: { name: string; description: string | null };
    /** What `latest` resolves to now (LatestModelResolution.model). */
    latestModel: string | null;
    /** The displayed explicit choice, `latest` when following. */
    selectedKey: string | null | undefined;
    machineDefault: { name: string; description: string | null };
}): ModelMode[] {
    const keepDefault = !MACHINE_CONFIG_AGENTS.includes(normalizeAgentKey(input.flavor)) || input.selectedKey === 'default';
    const out: ModelMode[] = [{ key: LATEST_MODEL_MODE, name: input.follow.name, description: input.follow.description }];
    for (const option of options) {
        if (option.key === LATEST_MODEL_MODE) continue;
        if (option.key === 'default') {
            if (keepDefault) out.push({ ...option, name: input.machineDefault.name, description: input.machineDefault.description });
            continue;
        }
        if (option.key === input.latestModel && input.selectedKey !== option.key) continue;
        out.push(option);
    }
    return out;
}

/** What the picker key means when sent to storage: `latest` = no explicit pick. */
export function modelPickToStore(key: string): string | null {
    return key === LATEST_MODEL_MODE ? null : key;
}

export type FollowLatestSessionSource = {
    createdAt?: number;
    updatedAt: number;
    metadata?: Pick<Metadata, 'flavor' | 'machineId' | 'models' | 'capabilities' | 'configuredModel'> | null;
};

export type MachineFollowLatest = { machineId: string; label: string; state: FollowLatestState };

/**
 * Settings → Agents (P2-3): one entry per known machine, in the given
 * (stable) machine order, resolved from that machine's newest-started session
 * of the agent exactly like a send from it would be. Machines with no such
 * session are left out — nothing proves what they run.
 */
export function followLatestByMachine(
    table: LatestModelTable | null | undefined,
    flavor: string,
    sessions: readonly FollowLatestSessionSource[],
    machines: ReadonlyArray<{ id: string; label: string }>,
): MachineFollowLatest[] {
    const agent = normalizeAgentKey(flavor);
    const started = (session: FollowLatestSessionSource) => session.createdAt ?? session.updatedAt;
    const newest = new Map<string, FollowLatestSessionSource>();
    for (const session of sessions) {
        const machineId = session.metadata?.machineId;
        if (!machineId || normalizeAgentKey(session.metadata?.flavor) !== agent) continue;
        const seen = newest.get(machineId);
        if (!seen || started(session) > started(seen)) newest.set(machineId, session);
    }
    const out: MachineFollowLatest[] = [];
    for (const machine of machines) {
        const metadata = newest.get(machine.id)?.metadata;
        if (!metadata) continue;
        out.push({ machineId: machine.id, label: machine.label, state: followLatestState(resolveLatestForAgent(table, agent, metadata), true) });
    }
    return out;
}

/** One account-level value: the shared state, `varies`, or `dependsOnMachine`. */
export function summarizeFollowLatest(entries: readonly MachineFollowLatest[]): FollowLatestState | { kind: 'varies' } {
    if (entries.length === 0) return { kind: 'dependsOnMachine' };
    const [first, ...rest] = entries;
    return rest.every((entry) => sameFollowLatestState(entry.state, first.state)) ? first.state : { kind: 'varies' };
}
