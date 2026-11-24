export const CLAUDE_LIVE_PERMISSION_CAPABILITY = 'claude-live-permission-v1';
/** CLI accepts set-permission-mode while idle too and publishes metadata.permissionMode. */
export const CLAUDE_LIVE_PERMISSION_V2_CAPABILITY = 'claude-live-permission-v2';

/** B-969: a dsh wrapper that switches its permission mode live (CLI 0.2.227+). */
export const DSH_LIVE_PERMISSION_CAPABILITY = 'dsh-live-permission-v1';

export function shouldApplyPermissionModeLive(input: {
    isClaude: boolean;
    /** B-969: dsh, live only behind DSH_LIVE_PERMISSION_CAPABILITY. */
    isDsh?: boolean;
    isWorking: boolean;
    isRemote: boolean;
    /** Session process reachable (presence online). Defaults to isWorking for v1 callers. */
    isOnline?: boolean;
    capabilities?: readonly string[] | null;
}): boolean {
    if (input.isDsh) {
        return input.isRemote
            && input.capabilities?.includes(DSH_LIVE_PERMISSION_CAPABILITY) === true
            && (input.isOnline ?? input.isWorking);
    }
    if (!input.isClaude || !input.isRemote) return false;
    if (input.capabilities?.includes(CLAUDE_LIVE_PERMISSION_V2_CAPABILITY) === true) {
        return input.isOnline ?? input.isWorking;
    }
    return input.isWorking
        && input.capabilities?.includes(CLAUDE_LIVE_PERMISSION_CAPABILITY) === true;
}
