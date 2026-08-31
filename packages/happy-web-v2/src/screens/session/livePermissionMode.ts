export const CLAUDE_LIVE_PERMISSION_CAPABILITY = 'claude-live-permission-v1';
/** CLI accepts set-permission-mode while idle too and publishes metadata.permissionMode. */
export const CLAUDE_LIVE_PERMISSION_V2_CAPABILITY = 'claude-live-permission-v2';

export function shouldApplyPermissionModeLive(input: {
    isClaude: boolean;
    isWorking: boolean;
    isRemote: boolean;
    /** Session process reachable (presence online). Defaults to isWorking for v1 callers. */
    isOnline?: boolean;
    capabilities?: readonly string[] | null;
}): boolean {
    if (!input.isClaude || !input.isRemote) return false;
    if (input.capabilities?.includes(CLAUDE_LIVE_PERMISSION_V2_CAPABILITY) === true) {
        return input.isOnline ?? input.isWorking;
    }
    return input.isWorking
        && input.capabilities?.includes(CLAUDE_LIVE_PERMISSION_CAPABILITY) === true;
}
