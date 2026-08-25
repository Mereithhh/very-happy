const WEB_TO_MACHINE_REALTIME = new Set(['terminal-input', 'terminal-resize', 'terminal-close']);
const MACHINE_TO_WEB_REALTIME = new Set(['terminal-output', 'terminal-exit', 'terminal-activity']);

export function isMachineRealtimeEvent(event: string): boolean {
    return WEB_TO_MACHINE_REALTIME.has(event);
}

export function shouldIgnoreLegacyRealtime(event: string, machineId: unknown, regionalConnected: boolean): boolean {
    return regionalConnected && typeof machineId === 'string' && MACHINE_TO_WEB_REALTIME.has(event);
}
