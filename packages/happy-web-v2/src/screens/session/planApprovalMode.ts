export type ClaudeApprovalMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';

/**
 * ExitPlanMode resumes the same Claude query immediately, before another user
 * message can carry the composer's newly selected permission mode. Include the
 * current selector value in that approval so approving a plan does not
 * silently fall back to Claude's default permission mode.
 */
export function planApprovalMode(
    tool: string,
    selectedMode: string | null | undefined,
): ClaudeApprovalMode | undefined {
    if (tool !== 'ExitPlanMode' && tool !== 'exit_plan_mode') return undefined;

    switch (selectedMode) {
        case 'default':
        case 'acceptEdits':
        case 'bypassPermissions':
            return selectedMode;
        case 'yolo':
            return 'bypassPermissions';
        case 'safe-yolo':
        case 'read-only':
            return 'default';
        default:
            return undefined;
    }
}
