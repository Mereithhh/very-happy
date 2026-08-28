export const CLAUDE_LIVE_PERMISSION_CAPABILITY = 'claude-live-permission-v1';

export function shouldApplyPermissionModeLive(input: {
    isClaude: boolean;
    isWorking: boolean;
    isRemote: boolean;
    capabilities?: readonly string[] | null;
}): boolean {
    return input.isClaude
        && input.isWorking
        && input.isRemote
        && input.capabilities?.includes(CLAUDE_LIVE_PERMISSION_CAPABILITY) === true;
}
