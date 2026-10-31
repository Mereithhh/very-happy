import { LATEST_MODEL_MODE, MACHINE_CONFIG_AGENTS, type LatestModelResolution, type LatestModelTable } from '@slopus/happy-wire';
import type { ModelMode } from '@/components/modelModeOptions';
import type { Metadata } from './storageTypes';
import { normalizeAgentKey, resolveLatestForAgent, type LauncherMachineContext } from './agentDefaults';
import { isCliVersionBelow } from '@/app/cliUpdatePolicy';

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

export function followLatestState(resolution: LatestModelResolution, resolvedForSession: boolean, opts?: { runFactsUnknown?: boolean }): FollowLatestState {
    if (opts?.runFactsUnknown) return { kind: 'machineDefault' };
    if (resolution.configured) return { kind: 'machineConfig', model: resolution.configured };
    if (resolution.model) return { kind: 'latest', model: resolution.model, label: resolution.label };
    return resolvedForSession ? { kind: 'machineDefault' } : { kind: 'dependsOnMachine' };
}

/**
 * B-849a: first Very Happy CLI whose Codex/Gemini wrapper reports the
 * machine's config model (`configuredModel`, B-844 / v0.2.188). Older ones
 * run their own default, which no Web resolution can name.
 */
export const RUN_FACTS_CLI_VERSION = '0.2.188';

/**
 * Whether a draft (no session yet) on this machine can name what follow-latest
 * runs. Evidence first: the machine's newest session of the agent published a
 * catalog without `configuredModel` → its wrapper does not report it. With no
 * such session, the daemon's CLI version decides (new wrappers are spawned
 * from it). Claude/pi need no machine-config fact.
 */
export function launcherReportsRunFacts(flavor: string | null | undefined, machine: LauncherMachineContext | null | undefined): boolean {
    if (!MACHINE_CONFIG_AGENTS.includes(normalizeAgentKey(flavor)) || !machine) return true;
    if (machine.catalog?.length) return machine.configuredModel !== undefined;
    return !(machine.cliVersion && isCliVersionBelow(machine.cliVersion, RUN_FACTS_CLI_VERSION));
}

/**
 * The model the follow entry runs, which the picker lists only once (QA23
 * P2-3): a machine-config pin wins over the tier's latest, so on a pinned
 * machine the pinned model, not the latest, collapses into the entry.
 */
export function followEntryModel(state: FollowLatestState): string | null {
    return state.kind === 'machineConfig' || state.kind === 'latest' ? state.model : null;
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
    /** What the follow entry runs now (followEntryModel): listed only through it unless pinned. */
    latestModel: string | null;
    /** The displayed explicit choice, `latest` when following. */
    selectedKey: string | null | undefined;
    machineDefault: { name: string; description: string | null; disabled?: boolean };
}): ModelMode[] {
    const keepDefault = !MACHINE_CONFIG_AGENTS.includes(normalizeAgentKey(input.flavor)) || input.selectedKey === 'default';
    const out: ModelMode[] = [{ key: LATEST_MODEL_MODE, name: input.follow.name, description: input.follow.description }];
    for (const option of options) {
        if (option.key === LATEST_MODEL_MODE) continue;
        if (option.key === 'default') {
            if (keepDefault) out.push({ ...option, name: input.machineDefault.name, description: input.machineDefault.description, ...(input.machineDefault.disabled ? { disabled: true } : {}) });
            continue;
        }
        // QA26 P2-4: a pinned `[1m]` twin is listed (and checked) under its base row.
        if (option.key === input.latestModel && input.selectedKey !== option.key && input.selectedKey !== `${option.key}[1m]`) continue;
        out.push(option);
    }
    return out;
}

/**
 * QA23 P2-3: the machine's own config model (custom picker models, B-688) is
 * what a machine-config follow entry runs — listing it again duplicated the
 * entry. Same rule as withFollowLatestOption: kept only when it is the
 * explicit selection.
 */
export function customModelsBesideFollow(custom: readonly string[], followModel: string | null, selectedKey: string | null | undefined): readonly string[] {
    return followModel ? custom.filter((key) => key !== followModel || key === selectedKey) : custom;
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

/**
 * B-844c (QA22c P2-3): what the follow entry's description may promise. An
 * old CLI does not switch until it is upgraded; Claude has no machine-config
 * pin for follow-latest to defer to (its default model is always sent).
 */
export function followLatestDescriptionKey(
    state: FollowLatestState,
    isClaude: boolean,
): 'session.chat.modelLatestDescription' | 'session.chat.modelLatestDescriptionClaude' | 'session.chat.modelLatestDescriptionUpgradeCli' {
    if (state.kind === 'machineDefault') return 'session.chat.modelLatestDescriptionUpgradeCli';
    return isClaude ? 'session.chat.modelLatestDescriptionClaude' : 'session.chat.modelLatestDescription';
}

/**
 * B-849a2 (QA26 P1): what Claude's 「本机配置」 (`default`, no model sent) may
 * name, and whether a pick of it here would take effect.
 *
 * Claude Code runs the machine's own `~/.claude/settings.json` `model` (or
 * `/model`) — not the catalog's `default` entry (that said Fable 5.1 while
 * dev-sg ran opus[1m]). The wrapper does not report that setting yet
 * (`configuredModel` for Claude is PR-B), so the entry names a model only from
 * facts: a reported `configuredModel`, or — when this session has been on
 * 「本机配置」 — the model it really runs (`currentModelCode`, 1M included).
 *
 * Sending no model mid-session does not move Claude off the model it runs
 * (it keeps the previous turn's), so in an existing session the entry is
 * selectable only while it is already the selection; a new session (draft)
 * may always pick it.
 */
export function claudeMachineConfigEntry(input: {
    inSession: boolean;
    /** The session's model key (`default` = 「本机配置」). */
    selectedKey: string | null | undefined;
    configuredModel?: string | null;
    running?: string | null;
    /**
     * B-849b: the wrapper switches a running session back to the settings model
     * on `model: null` (claude-config-model-v1) — pickable mid-session.
     */
    liveSwitch?: boolean;
}): { model: string | null; selectable: boolean } {
    const onIt = input.inSession && input.selectedKey === 'default';
    // B-849b: where the wrapper switches to the settings model, that model is
    // what the entry runs (the turn on screen may still be the previous one).
    const model = (onIt && !(input.liveSwitch && input.configuredModel) ? input.running || input.configuredModel : input.configuredModel) || null;
    return { model, selectable: !input.inSession || onIt || input.liveSwitch === true };
}
