import { describe, expect, it } from 'vitest';
import { sessionApprovalPolicy } from './permissionCompatibility';

describe('sessionApprovalPolicy', () => {
    it('preserves the legacy allowTools request for an old CLI', () => {
        expect(sessionApprovalPolicy({ tool: 'Edit' }, true)).toEqual({
            visible: true,
            allowedTools: ['Edit'],
        });
    });

    it('uses modern SDK suggestions without reconstructing allowTools', () => {
        expect(sessionApprovalPolicy({
            tool: 'Edit',
            kind: 'tool',
            permissionSuggestions: [{ type: 'addRules', destination: 'session' }],
        }, true)).toEqual({ visible: true });
    });

    it('hides modern session approval without suggestions and for interactions', () => {
        expect(sessionApprovalPolicy({ tool: 'Edit', kind: 'tool' }, true)).toEqual({ visible: false });
        expect(sessionApprovalPolicy({ tool: 'AskUserQuestion', kind: 'elicitation' }, false)).toEqual({ visible: false });
        expect(sessionApprovalPolicy({ tool: 'AskUserQuestion', kind: 'user_dialog' }, false)).toEqual({ visible: false });
    });
});
