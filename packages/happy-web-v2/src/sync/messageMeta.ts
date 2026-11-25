import type { Session } from './storageTypes';
import type { Settings } from './settings';
import { getAgentDefaultOverride, getCodeAgentDefaults, isPiAgent, normalizeAgentKey, resolveDefaultModelMode } from './agentDefaults';
import { getLatestModelTable } from './latestModels';
import { isLatestModelMode, type LatestModelTable } from '@slopus/happy-wire';
import { normalizeClaudeOutboundMode } from './permissionModeOutbound';
import { getEffortLevelsForModel } from '@/components/modelModeOptions';
import type { PermissionModeKey } from '@/components/PermissionModeSelector';
import { EFFORT_PICK_AUTO, recordsRunIntent, sessionRunIntents, withRunPicks } from './runPicks';
import { readEffortIntent } from '@slopus/happy-wire';
import { codexContextOptions, resolveCodexContextMode } from './codexContextMode';

export type MessageModeMeta = {
    permissionMode?: PermissionModeKey;
    model?: string | null;
    effort?: string | null;
    /** B-977: Codex context window ('standard' | 'extended'); the wrapper applies it from the next turn. */
    codexContext?: string;
    /** B-849b: the choice behind `model` / `effort`, recorded by the wrapper as the session's intent. */
    modelIntent?: string;
    effortIntent?: string;
};

export function resolveMessageModeMeta(
    sessionIn: Pick<Session, 'permissionMode' | 'modelMode' | 'metadata' | 'effortLevel'> & { id?: string; contextMode?: string | null },
    settings?: Pick<Settings, 'agentDefaultOverrides'> & Partial<Pick<Settings, 'claudeLongContextOptOut'>>,
    latestTable: LatestModelTable | null = getLatestModelTable(),
): MessageModeMeta {
    // B-849b: the session's own choice (wrapper-recorded intent, a pending
    // local pick, else what it runs) — never another device's account default.
    const session = withRunPicks(sessionIn);
    const agentOverrides = getAgentDefaultOverride(settings?.agentDefaultOverrides, session.metadata?.flavor);
    const meta: MessageModeMeta = {};
    const isClaude = normalizeAgentKey(session.metadata?.flavor) === 'claude';
    // pi (flavor 'acp') has its own defaults slot (B-370) but speaks Claude's
    // permission vocabulary (B-350: the runner allowlists default | acceptEdits |
    // plan | bypassPermissions, `yolo` aliased) and honors meta.permissionMode in
    // both directions too — so the clean-up and the upgrade-only fallback below
    // apply to it as well. Model/effort keep the non-Claude omit-when-unset rule.
    const claudeModeVocab = isClaude || isPiAgent(session.metadata?.flavor);

    // B-262 A2 (asymmetric): a resolved session value is always sent; when the
    // session has no value, fall back to the synced per-agent override ONLY —
    // never to the code default. The CLI honors meta.permissionMode in BOTH
    // directions on every released version, so sending a guessed
    // `bypassPermissions` would silently switch assistant / review-first /
    // forked sessions nobody chose yolo for. For claude the value is also
    // normalized so a dead selector key (dontAsk) can never make the CLI
    // drop the whole message (its MessageMetaSchema enum would reject it).
    if (session.permissionMode !== null && session.permissionMode !== undefined) {
        const normalized = claudeModeVocab ? normalizeClaudeOutboundMode(session.permissionMode) : session.permissionMode;
        if (normalized) meta.permissionMode = normalized as PermissionModeKey;
    } else if (agentOverrides.permissionMode !== undefined) {
        if (claudeModeVocab) {
            // Upgrade-only fallback: a synced override of `plan`/`acceptEdits`
            // must not pull a session another device just put in yolo back down.
            const normalized = normalizeClaudeOutboundMode(agentOverrides.permissionMode);
            if (normalized === 'bypassPermissions') meta.permissionMode = normalized;
        } else {
            meta.permissionMode = agentOverrides.permissionMode as PermissionModeKey;
        }
    }

    // B-103: for claude, ALWAYS send model/effort explicitly — `null` means
    // "reset to the machine's own default" on the CLI (both fields already
    // decode null → undefined there, on every released version). Omitting the
    // field instead leaves the CLI's sticky per-session state in force.
    // Claude falls back to the code default `latest`, resolved for this
    // wrapper (B-844: newest Opus it proves it runs, else null = machine
    // default), so the picker and the running model agree. Codex/Gemini
    // following latest send the model their published catalog proves, and
    // nothing (machine default) until it does. `latest` itself never leaves.
    // B-844c: "nothing" would leave a model this session was sent earlier in
    // force (the wrapper keeps it), so when the wrapper reports one sticky we
    // send null — reset to the machine default the picker shows.
    // B-848: a session that picked 「跟随最新」 itself follows latest whatever the account default pins.
    const sessionFollowsLatest = isLatestModelMode(session.modelMode);
    const followsLatest = sessionFollowsLatest || isLatestModelMode(agentOverrides.modelMode ?? getCodeAgentDefaults(session.metadata?.flavor).modelMode);
    const resolvedDefault = isClaude || followsLatest
        ? resolveDefaultModelMode(sessionFollowsLatest ? undefined : settings?.agentDefaultOverrides, session.metadata?.flavor, session.metadata ?? {}, { table: latestTable, longContextOptOut: settings?.claudeLongContextOptOut === true })
        : agentOverrides.modelMode;
    const modelMode = session.modelMode && !isLatestModelMode(session.modelMode)
        ? session.modelMode
        : (!isClaude && followsLatest && resolvedDefault === 'default'
            ? (typeof session.metadata?.stickyModel === 'string' ? 'default' : undefined)
            : resolvedDefault);
    // B-849a (B-846 short term): Gemini's model is the machine config's — its
    // wrapper writes any sent model into the machine-wide ~/.gemini config, so
    // the Web never sends one (the picker is read-only for Gemini).
    if (modelMode !== undefined && normalizeAgentKey(session.metadata?.flavor) !== 'gemini') {
        meta.model = modelMode === 'default' ? null : modelMode;
        // B-849b: the choice, not just its resolution — 「跟随最新」 stays latest.
        meta.modelIntent = session.modelMode && !isLatestModelMode(session.modelMode)
            ? session.modelMode
            : followsLatest ? 'latest' : modelMode;
    } else if (followsLatest && normalizeAgentKey(session.metadata?.flavor) !== 'gemini') {
        // Codex following latest defers to its machine config and sends no
        // model; the choice is still the session's to record.
        meta.modelIntent = 'latest';
    }

    // B-849b: an explicit 「自动」 pick is stored as `default` = no effort sent.
    // B-975: a recorded Codex level the (changed) model refuses is settled here and said,
    // rather than omitted and settled silently by the wrapper.
    const effort = session.effortLevel === EFFORT_PICK_AUTO ? null : (session.effortLevel ?? agentOverrides.effortLevel ?? refusedIntent(session.metadata));
    if (effort !== undefined) {
        const flavor = session.metadata?.flavor ?? 'claude';
        const modelKey = modelMode ?? session.metadata?.currentModelCode ?? 'default';
        const levels = getEffortLevelsForModel(flavor, modelKey, session.metadata);
        // B-975: a recording Codex wrapper that published no catalog gives no verdict — Codex validates the level and says so.
        const unjudged = normalizeAgentKey(flavor) === 'codex' && recordsRunIntent(session.metadata) && !session.metadata?.models?.length;
        if (effort === null || unjudged || levels.some((level) => level.key === effort)) {
            meta.effort = effort;
        } else {
            const resolvedModel = modelKey === 'default' ? session.metadata?.defaultModelCode : modelKey;
            const model = session.metadata?.models?.find((item) => item.code === resolvedModel || item.resolvedModel === resolvedModel);
            const candidates = [session.metadata?.currentThoughtLevelCode,
                isPiAgent(flavor) ? session.metadata?.currentOperatingModeCode : undefined,
                model?.defaultReasoningEffort];
            // Explicit null clears Codex/Claude sticky overrides when changing
            // to a model that cannot honor the previous level.
            meta.effort = candidates.find((candidate) => levels.some((level) => level.key === candidate)) ?? null;
        }
    } else if (isClaude) {
        meta.effort = null;
    }
    if (meta.effort !== undefined) meta.effortIntent = meta.effort ?? EFFORT_PICK_AUTO;

    // B-977: Codex 「上下文」 — sent whenever the session has a choice to state
    // (the wrapper's report, a pick, or the account default), so a mode picked
    // on another device is never left behind. A model with one window sends
    // nothing.
    if (normalizeAgentKey(session.metadata?.flavor) === 'codex') {
        const model = modelMode && modelMode !== 'default' ? modelMode : session.metadata?.currentModelCode;
        const choices = codexContextOptions(session.metadata, model);
        if (choices) meta.codexContext = resolveCodexContextMode(session.metadata, session.contextMode, agentOverrides.contextMode);
    }

    return meta;
}

/** The recorded Codex level its model cannot run (read as "no choice" elsewhere), if any. */
function refusedIntent(metadata: Session['metadata']): string | undefined {
    if (normalizeAgentKey(metadata?.flavor) !== 'codex' || !recordsRunIntent(metadata)) return undefined;
    const raw = readEffortIntent(metadata?.effortIntent);
    return typeof raw === 'string' && raw !== EFFORT_PICK_AUTO && sessionRunIntents(metadata).effort === null ? raw : undefined;
}

export type EffortDowngrade = {
    requested: string;
    /** What the next message runs instead; null = Codex's own default. */
    actual: string | null;
};

/**
 * B-975: the level this Codex session is set to, when its model cannot run it
 * and the next message goes out at another one. Said before sending.
 */
export function codexEffortDowngrade(
    session: Parameters<typeof resolveMessageModeMeta>[0],
    settings?: Parameters<typeof resolveMessageModeMeta>[1],
    latestTable: LatestModelTable | null = getLatestModelTable(),
): EffortDowngrade | null {
    if (normalizeAgentKey(session.metadata?.flavor) !== 'codex') return null;
    const requested = withRunPicks(session).effortLevel
        ?? refusedIntent(session.metadata)
        ?? getAgentDefaultOverride(settings?.agentDefaultOverrides, session.metadata?.flavor).effortLevel;
    if (!requested || requested === EFFORT_PICK_AUTO) return null;
    const meta = resolveMessageModeMeta(session, settings, latestTable);
    const actual = meta.effort;
    // A model listed with no levels at all (an API account's own models) has no effort to choose.
    const modelKey = meta.model ?? session.metadata?.currentModelCode ?? 'default';
    if (getEffortLevelsForModel('codex', modelKey, session.metadata).length === 0) return null;
    return actual === requested ? null : { requested, actual: actual ?? null };
}
