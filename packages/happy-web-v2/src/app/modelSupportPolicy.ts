/**
 * modelSupportPolicy (B-487) — a session whose wrapper or agent CLI is too old
 * to run the model the user wants, so the web can say so instead of letting it
 * fall back (Claude) or fail on the backend (Codex).
 *
 * Capability, not version, decides what a wrapper can do (AGENTS.md
 * constraint 14): Claude sessions are judged by `claude-opus-5-5-v1`, Codex
 * sessions by the model catalog the wrapper published from `model/list`.
 * Versions only pick the wording and the fix (update vs. restart).
 *
 * Pure rules only; the strip that renders them is
 * screens/session/ModelSupportBanner.tsx.
 */
import { isCliVersionBelow } from './cliUpdatePolicy';
import { machineCliVersion, type StaleWrapperMachineLike } from './staleWrapperPolicy';
import { readAgentVersions } from './agentVersions';
import {
    CLAUDE_OPUS_55_MODEL,
    getAgentDefaultOverride,
    getCodeAgentDefaults,
    supportsClaudeOpus55,
    type AgentDefaultOverrides,
} from '@/sync/agentDefaults';

/**
 * First very-happy-cli whose wrapper can run Opus 5.5: it bundles
 * claude-agent-sdk 0.3.281 (Claude Code 2.1.281) and advertises
 * `claude-opus-5-5-v1`. SDK 0.3.267 (CLI ≤ 0.2.148) gets a 400 "version
 * 2.1.280 or newer is required" (probed 2026-09-24).
 */
export const OPUS_55_MIN_CLI_VERSION = '0.2.149';

/**
 * First Codex CLI whose `model/list` carries gpt-6-sol / gpt-6-luna. With a
 * ChatGPT sign-in, 0.150.0 and 0.154.0 get 400 "The 'gpt-6-sol' model is not
 * supported when using Codex with a ChatGPT account"; 0.155.0 and 0.156.1 run
 * both (probed 2026-09-24). API-key providers run them on older versions too.
 */
export const CODEX_GPT6_MIN_VERSION = '0.155.0';
export const CODEX_GPT6_MODELS: readonly string[] = ['gpt-6-sol', 'gpt-6-luna'];
export const CODEX_UPDATE_COMMAND = 'npm install -g @openai/codex@latest';

export interface ModelSupportSessionLike {
    archivedAt?: number | null;
    modelMode?: string | null;
    metadata?: {
        machineId?: string;
        version?: string;
        flavor?: string | null;
        capabilities?: string[] | null;
        models?: Array<{ code: string }> | null;
    } | null;
}

export interface ModelSupportMachineLike extends StaleWrapperMachineLike {
    daemonState?: (StaleWrapperMachineLike['daemonState'] & {
        pid?: unknown;
        agentVersionEpoch?: unknown;
        agentVersions?: unknown;
        cliUpdate?: { currentVersion?: unknown; recommendedVersion?: unknown } | null;
    }) | null;
}

export type ModelSupportNotice =
    | {
        kind: 'claude-opus-55';
        model: string;
        /** 'update' = the machine's CLI itself is too old; 'restart' = the
         *  machine already has it and only this wrapper predates it. */
        action: 'update' | 'restart';
        wrapperVersion: string | null;
        machineVersion: string | null;
        targetVersion: string;
    }
    | {
        kind: 'codex-gpt6';
        model: string;
        /** 'update' = install a newer Codex, then restart; 'restart' = the
         *  machine's Codex is new enough, the session started before it. */
        action: 'update' | 'restart';
        installedVersion: string | null;
        minVersion: string;
    };

function isOpus55(model: string | null | undefined): model is string {
    return model === CLAUDE_OPUS_55_MODEL || model === `${CLAUDE_OPUS_55_MODEL}[1m]`;
}

/** The model the user asked this session to run: an explicit pick, else the
 *  synced default, else the code default — deliberately NOT capability-gated
 *  (the gate is what silently drops Opus 5.5 on an old wrapper). */
export function wantedModel(
    session: Pick<ModelSupportSessionLike, 'modelMode' | 'metadata'>,
    overrides: AgentDefaultOverrides | null | undefined,
): string {
    const flavor = session.metadata?.flavor;
    return session.modelMode
        ?? getAgentDefaultOverride(overrides, flavor).modelMode
        ?? getCodeAgentDefaults(flavor).modelMode;
}

/** Larger of two versions; an unparsable candidate never wins. */
function atLeast(candidate: unknown, floor: string): string {
    return typeof candidate === 'string' && isCliVersionBelow(floor, candidate.trim()) ? candidate.trim() : floor;
}

export function modelSupportNotice(
    session: ModelSupportSessionLike | null | undefined,
    machine: ModelSupportMachineLike | null | undefined,
    overrides: AgentDefaultOverrides | null | undefined,
): ModelSupportNotice | null {
    const metadata = session?.metadata;
    if (!session || !metadata || session.archivedAt != null) return null;
    if (metadata.flavor === 'terminal-mirror') return null;
    const model = wantedModel(session, overrides);

    if ((metadata.flavor ?? 'claude') === 'claude') {
        if (!isOpus55(model) || supportsClaudeOpus55(metadata)) return null;
        const machineVersion = machineCliVersion(machine);
        const machineReady = machineVersion !== null && !isCliVersionBelow(machineVersion, OPUS_55_MIN_CLI_VERSION);
        return {
            kind: 'claude-opus-55',
            model,
            action: machineReady ? 'restart' : 'update',
            wrapperVersion: metadata.version?.trim() || null,
            machineVersion,
            targetVersion: atLeast(machine?.daemonState?.cliUpdate?.recommendedVersion, OPUS_55_MIN_CLI_VERSION),
        };
    }

    if (metadata.flavor === 'codex') {
        if (!CODEX_GPT6_MODELS.includes(model)) return null;
        // No published catalog = a wrapper too old to discover models; its
        // picker never offered these, and nothing tells us what it can run.
        const catalog = metadata.models ?? [];
        if (catalog.length === 0 || catalog.some((entry) => entry.code === model)) return null;
        const installed = readAgentVersions(machine?.daemonState)?.agents.find((agent) => agent.id === 'codex')?.installed ?? null;
        const installedReady = installed !== null && !isCliVersionBelow(installed, CODEX_GPT6_MIN_VERSION);
        return {
            kind: 'codex-gpt6',
            model,
            action: installedReady ? 'restart' : 'update',
            installedVersion: installed,
            minVersion: CODEX_GPT6_MIN_VERSION,
        };
    }
    return null;
}

/** Dismissal is per session, per model and per wrapper/agent version: a
 *  restart or an upgrade that still falls short is worth one more notice. */
export function modelSupportHintKey(sessionId: string, notice: ModelSupportNotice): string {
    const version = notice.kind === 'claude-opus-55' ? notice.wrapperVersion : notice.installedVersion;
    return `model-support:${sessionId}:${notice.kind}:${notice.model}:${version ?? 'unknown'}`;
}

export function isModelSupportNoticeVisible(
    hintKey: string,
    dismissedHints: Readonly<Record<string, number>> | undefined,
): boolean {
    return typeof dismissedHints?.[hintKey] !== 'number';
}
