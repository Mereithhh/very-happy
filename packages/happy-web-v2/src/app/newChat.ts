import type { NavigateFunction } from 'react-router-dom';
import { storage } from '@/sync/storage';
import { sync } from '@/sync/sync';
import { machineSpawnNewSession } from '@/sync/ops';
import { normalizeAgentKey, resolveNewSessionPermissionMode } from '@/sync/agentDefaults';
import { decideQuickChat, pushRecentMachinePath } from '@/utils/quickChat';
import { Modal } from '@/modal';
import { t } from '@/text';

/**
 * The ONE quick "new chat" entry point (chat sibling of newTerminal.ts's
 * createTerminalOrPick). Default behavior is DIRECT creation — no options
 * dialog: machine/directory come from decideQuickChat (sole online machine,
 * else the most recent remembered combination), the agent from the
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
 */

let inFlight = false;

/** Remember a successful machine+directory so the next quick create reuses it. */
export function recordRecentMachinePath(machineId: string, path: string): void {
    const current = storage.getState().settings.recentMachinePaths ?? [];
    sync.applySettings({ recentMachinePaths: pushRecentMachinePath(current, { machineId, path }) });
}

export async function createChatOrConfigure(
    navigate: NavigateFunction,
    openConfigure: () => void,
): Promise<void> {
    if (inFlight) return;
    const state = storage.getState();
    const decision = decideQuickChat({
        machines: Object.values(state.machines),
        recents: state.settings.recentMachinePaths ?? [],
        alwaysAsk: state.settings.newSessionAlwaysAsk === true,
    });
    if (decision.kind === 'configure') {
        openConfigure();
        return;
    }
    inFlight = true;
    try {
        const agent = normalizeAgentKey(state.settings.newSessionAgent);
        const permissionMode = resolveNewSessionPermissionMode(
            state.settings.agentDefaultOverrides,
            agent,
            state.localSettings.newSessionReviewFirst,
        );
        const res = await machineSpawnNewSession({
            machineId: decision.machineId,
            directory: decision.directory,
            agent,
            permissionMode,
        });
        if (res.type === 'requestToApproveDirectoryCreation') {
            // The remembered directory vanished — never silently mkdir from the
            // quick path; hand over to the dialog where creation is explicit.
            openConfigure();
            return;
        }
        if (res.type === 'error') {
            Modal.alert(t('common.error'), res.errorMessage || t('errors.networkError'));
            return;
        }
        storage.getState().updateSessionPermissionMode(res.sessionId, permissionMode);
        recordRecentMachinePath(decision.machineId, decision.directory);
        navigate(`/session/${res.sessionId}`);
    } catch (e) {
        Modal.alert(t('common.error'), e instanceof Error ? e.message : t('errors.networkError'));
    } finally {
        inFlight = false;
    }
}
