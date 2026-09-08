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
