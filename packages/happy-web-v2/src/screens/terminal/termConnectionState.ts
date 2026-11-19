export type TerminalConnectionNoticeState = 'offline' | 'checking' | 'connecting' | 'failed' | null;

/** Control disconnection invalidates cached presence, not necessarily the regional data path. */
export function terminalConnectionNotice(input: {
    controlConnected: boolean;
    regionalConnected: boolean;
    machineActive: boolean | undefined;
    opening: boolean;
    failed: boolean;
}): TerminalConnectionNoticeState {
    if (input.controlConnected && input.machineActive === false) return 'offline';
    if (input.failed) return 'failed';
    if (!input.controlConnected && !(input.regionalConnected && !input.opening)) return 'checking';
    if (input.opening) return 'connecting';
    return null;
}

/**
 * B-943: the terminal's machine just came back (`active` false → true). A restarted daemon
 * holds no subscribers, so the pane must re-subscribe by itself — nobody should have to
 * refresh. A pane whose open failed rebuilds; an open one catches up from a fresh snapshot.
 * Nothing for any other transition (first load, still offline, already online).
 */
export type MachineReturnAction = 'remount' | 'catch-up' | null;
export function machineReturnAction(input: { wasActive: boolean | undefined; active: boolean | undefined; openFailed: boolean }): MachineReturnAction {
    if (input.wasActive !== false || input.active !== true) return null;
    return input.openFailed ? 'remount' : 'catch-up';
}
