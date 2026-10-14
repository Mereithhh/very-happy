import type { Message } from './typesMessage';
import type { NormalizedMessage } from './typesRaw';
import type { AgentState } from './storageTypes';

type OrderedModeMessage = {
    id: string;
    seq?: number | null;
    createdAt: number;
    permissionMode: string;
};

function newest(items: OrderedModeMessage[]): OrderedModeMessage | undefined {
    return items.sort((a, b) => {
        if (typeof a.seq === 'number' && typeof b.seq === 'number' && a.seq !== b.seq) return b.seq - a.seq;
        return b.createdAt - a.createdAt;
    })[0];
}

function existingUserModes(messages: readonly Message[]): OrderedModeMessage[] {
    return messages.flatMap((message) => {
        const mode = message.kind === 'user-text' ? message.meta?.permissionMode?.trim() : undefined;
        return mode ? [{ id: message.id, seq: message.seq, createdAt: message.createdAt, permissionMode: mode }] : [];
    });
}

function incomingUserModes(messages: readonly NormalizedMessage[]): OrderedModeMessage[] {
    return messages.flatMap((message) => {
        const mode = message.role === 'user' ? message.meta?.permissionMode?.trim() : undefined;
        return mode ? [{ id: message.id, seq: message.seq, createdAt: message.createdAt, permissionMode: mode }] : [];
    });
}

/**
 * Rehydrate the composer mode from the latest sent user turn. Only a new user
 * message can move the UI: assistant traffic and older history pages must not
 * overwrite a local mode selected for the next, not-yet-sent turn.
 */
export function resolveIncomingPermissionMode(
    existing: readonly Message[],
    incoming: readonly NormalizedMessage[],
): string | undefined {
    const next = newest(incomingUserModes(incoming));
    if (!next) return undefined;

    const current = newest(existingUserModes(existing));
    if (!current || current.id === next.id) return next.permissionMode;
    if (typeof next.seq === 'number' && typeof current.seq === 'number') {
        return next.seq > current.seq ? next.permissionMode : undefined;
    }
    return next.createdAt > current.createdAt ? next.permissionMode : undefined;
}

/**
 * Claude CLIs (capability claude-live-permission-v2) publish the mode they
 * actually enforce in session metadata. That value is the truth for display
 * and for every outbound meta/plan approval. It overrides the device-local
 * selection whenever the CLI reports a *change* (or the device has nothing);
 * an unchanged published value must not clobber an optimistic local pick that
 * is still round-tripping through the set-permission-mode RPC.
 */
export function resolveSessionPermissionMode(input: {
    publishedMode: string | null | undefined;
    previousPublishedMode: string | null | undefined;
    localMode: string | null;
}): string | null {
    const { publishedMode, previousPublishedMode, localMode } = input;
    if (!publishedMode) return localMode;
    if (localMode === null || publishedMode !== previousPublishedMode) return publishedMode;
    return localMode;
}

type CompletedRequests = NonNullable<AgentState['completedRequests']>;

const PLAN_FOLLOW_UP_MODES = new Set(['default', 'acceptEdits', 'bypassPermissions']);

/**
 * B-604: leave the web's local `plan` once the plan is approved.
 *
 * The local `plan` comes from the EnterPlanMode heuristic in
 * storage.applyMessages. When Claude enters plan mode on its own (EnterPlanMode
 * is auto-allowed in bypassPermissions and never reaches canUseTool), the CLI
 * does not republish metadata.permissionMode, so resolveSessionPermissionMode
 * sees no published change after the approval either and would keep `plan`
 * forever — and the next message would carry meta.permissionMode=plan.
 *
 * An approved ExitPlanMode is recorded by every CLI ≥0.2.91 in
 * agentState.completedRequests with the approval `mode`; the CLI then runs in
 * that mode, or in bypassPermissions when it was missing/plan/unknown
 * (permissionHandler.handlePermissionResponse). Mirror exactly that. Only a
 * completion that is new relative to a known previous agentState counts: a
 * cold load has no baseline and old completions must not override a plan mode
 * picked later (published metadata covers cold loads anyway).
 */
export function resolvePlanExitPermissionMode(input: {
    previous: CompletedRequests | null | undefined;
    next: CompletedRequests | null | undefined;
    mode: string | null;
}): string | null {
    const { previous, next, mode } = input;
    if (mode !== 'plan' || !previous || !next) return null;
    let latest: { completedAt: number; mode: string } | null = null;
    for (const [id, request] of Object.entries(next)) {
        if (previous[id]) continue;
        if (request.tool !== 'ExitPlanMode' && request.tool !== 'exit_plan_mode') continue;
        if (request.status !== 'approved') continue;
        const followUp = request.mode && PLAN_FOLLOW_UP_MODES.has(request.mode) ? request.mode : 'bypassPermissions';
        const completedAt = request.completedAt ?? 0;
        if (!latest || completedAt >= latest.completedAt) latest = { completedAt, mode: followUp };
    }
    return latest?.mode ?? null;
}
