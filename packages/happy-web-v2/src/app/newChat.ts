import { useSyncExternalStore } from 'react';
import type { NavigateFunction } from 'react-router-dom';
import { storage } from '@/sync/storage';
import { normalizeAgentKey, resolveNewSessionPermissionMode } from '@/sync/agentDefaults';
import { decideQuickChat } from '@/utils/quickChat';
import { newChatLocation } from '@/utils/newChatLocation';
import { useTerminalSessions } from '@/sync/terminalSessions';
import type { RecentMachinePath } from '@/utils/quickChat';
import { pendingSessions } from '@/sync/pendingSessionsRuntime';
import { newSessionTimingStart } from './newSessionTiming';
import { prefetchSessionDetail } from './prefetchSessionDetail';

export { recordRecentMachinePath } from './recentMachinePath';
import { currentSpawnOrigin, hasUserGesture } from '@/sync/spawnOrigin';

/**
 * The ONE quick "new chat" entry point (chat sibling of newTerminal.ts's
 * createTerminalOrPick). Default behavior is DIRECT creation — no options
 * dialog: machine/directory come from the chosen workspace or current route,
 * falling back to decideQuickChat history only without that context, the agent from the
 * newSessionAgent setting, and model/effort/permission are not spawn inputs
 * at all — every message resolves them from Settings → Agents, so with no
 * explicit override the machine's own CLI configuration applies.
 *
 * `openConfigure` opens the full NewSessionModal and is used whenever the
 * quick path can't decide (nothing remembered / ambiguous machine / the
 * remembered directory no longer exists) or the user opted into always-ask.
 *
 * Reads the stores imperatively (getState) so callers don't need to subscribe
 * to machines/settings just to render a "+" button.
 *
 * B-516: creation is optimistic — a pending record is created and the pending
 * session page opens at once; the spawn, a directory-creation approval and the
 * first messages are handled there (sync/pendingSessions.ts). The global lock
 * below only covers "until the pending page is on screen"; duplicate spawns
 * are prevented per pending id by the store.
 */

/** Longest the "+" stays locked if the pending page never reports itself shown. */
const SHOWN_LOCK_MAX_MS = 1_500;

let inFlight = false;
const pendingListeners = new Set<() => void>();
function setPending(value: boolean) {
    inFlight = value;
    pendingListeners.forEach(listener => listener());
}
export function useNewChatPending() {
    return useSyncExternalStore(
        listener => { pendingListeners.add(listener); return () => { pendingListeners.delete(listener); }; },
        () => inFlight,
        () => false,
    );
}

export async function createChatOrConfigure(
    navigate: NavigateFunction,
    openConfigure: (target?: RecentMachinePath) => void,
    context?: {
        target?: RecentMachinePath;
        location?: { pathname: string; search?: string };
        /** B-552: prefill the new chat's composer (never sent automatically).
         *  Only the quick path consumes it; a caller that opens the configure
         *  dialog prefills that dialog itself. */
        draft?: string;
        /** B-649: created from a project group / page — joins it before its first message. */
        projectId?: string;
    },
): Promise<void> {
    if (inFlight) return;
    const state = storage.getState();
    const target = context?.target
        ?? pendingRouteLocation(context?.location)
        ?? newChatLocation(context?.location, state.sessions, useTerminalSessions.getState().terminals);
    const decision = decideQuickChat({
        target,
        machines: Object.values(state.machines),
        recents: state.settings.recentMachinePaths ?? [],
        alwaysAsk: state.settings.newSessionAlwaysAsk === true,
    });
    // B-723 (O5): the quick path creates a session at once, with no first
    // message — only ever as the direct result of a click / key press. Anything
    // else (a late async call, a replayed handler) gets the dialog instead of
    // an empty 「新对话」 nobody asked for.
    if (decision.kind === 'configure' || !hasUserGesture(typeof navigator === 'undefined' ? undefined : navigator as Navigator & { userActivation?: { isActive: boolean } })) {
        if (decision.kind !== 'configure') console.warn('[newChat] quick chat without a user gesture; opening the dialog instead', currentSpawnOrigin('quick'));
        openConfigure(target);
        return;
    }
    setPending(true);
    newSessionTimingStart('quick');
    try {
        prefetchSessionDetail();
        const agent = normalizeAgentKey(state.settings.newSessionAgent);
        const permissionMode = resolveNewSessionPermissionMode(
            state.settings.agentDefaultOverrides,
            agent,
            state.localSettings.newSessionReviewFirst,
        );
        const record = pendingSessions.create({
            machineId: decision.machineId,
            path: decision.directory,
            agent,
            permissionMode,
            source: 'quick',
            ...(context?.projectId ? { onSpawnedProject: { projectId: context.projectId } } : {}),
        });
        // The pending page reads its initial composer text from the draft
        // store (pendingDraft), and migrateDraft carries it to the real id.
        if (context?.draft?.trim()) state.updateSessionDraft(record.pendingId, context.draft);
        navigate(`/session/${record.pendingId}`);
        await pendingSessions.waitShown(record.pendingId, SHOWN_LOCK_MAX_MS);
    } finally {
        setPending(false);
    }
}

/** A pending page (B-516) has no session in the store yet — its record carries the scope. */
function pendingRouteLocation(location: { pathname: string } | undefined): RecentMachinePath | undefined {
    const match = location?.pathname.match(/^\/session\/([^/]+)/);
    if (!match) return undefined;
    let id: string;
    try { id = decodeURIComponent(match[1]); } catch { return undefined; }
    const record = pendingSessions.forRoute(id);
    return record ? { machineId: record.machineId, path: record.path } : undefined;
}
