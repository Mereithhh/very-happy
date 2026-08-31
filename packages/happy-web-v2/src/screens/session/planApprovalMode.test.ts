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

    it('does not attach a mode to ordinary tool approvals', () => {
        expect(planApprovalMode('Bash', 'bypassPermissions')).toBeUndefined();
    });

    it('runs an approved plan in yolo when the selection is plan or unresolved', () => {
        expect(planApprovalMode('ExitPlanMode', 'plan')).toBe('bypassPermissions');
        expect(planApprovalMode('ExitPlanMode', null)).toBe('bypassPermissions');
        expect(planApprovalMode('ExitPlanMode', undefined)).toBe('bypassPermissions');
    });
});
