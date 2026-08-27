import { describe, expect, it } from 'vitest';
import { planApprovalMode } from './planApprovalMode';

describe('planApprovalMode', () => {
    it('keeps the manually selected YOLO mode when approving a Claude plan', () => {
        expect(planApprovalMode('ExitPlanMode', 'bypassPermissions')).toBe('bypassPermissions');
        expect(planApprovalMode('exit_plan_mode', 'yolo')).toBe('bypassPermissions');
    });

    it('maps non-Claude safety modes to their Claude approval equivalent', () => {
        expect(planApprovalMode('ExitPlanMode', 'safe-yolo')).toBe('default');
        expect(planApprovalMode('ExitPlanMode', 'read-only')).toBe('default');
    });

    it('does not attach a mode to ordinary tool approvals or an unresolved plan selection', () => {
        expect(planApprovalMode('Bash', 'bypassPermissions')).toBeUndefined();
        expect(planApprovalMode('ExitPlanMode', 'plan')).toBeUndefined();
        expect(planApprovalMode('ExitPlanMode', null)).toBeUndefined();
    });
});
