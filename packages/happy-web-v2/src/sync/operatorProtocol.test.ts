import { describe, expect, it } from 'vitest';
import {
    OPERATOR_SESSION_METHODS,
    operatorModeAllowed,
    operatorModeBound,
    operatorModeChoices,
    parseOperatorExit,
    parseOperatorOutput,
    permissionModeRank,
    readOperatorAck,
} from './operatorProtocol';

describe('B-867 operator permission-mode cap', () => {
    it('ranks the known modes and refuses unknown ones', () => {
        expect(permissionModeRank('plan')).toBe(0);
        expect(permissionModeRank('read-only')).toBe(0);
        expect(permissionModeRank('default')).toBe(1);
        expect(permissionModeRank('acceptEdits')).toBe(2);
        expect(permissionModeRank('safe-yolo')).toBe(2);
        expect(permissionModeRank('bypassPermissions')).toBe(3);
        expect(permissionModeRank('yolo')).toBe(3);
        expect(permissionModeRank('future-mode')).toBeNull();
    });
    it('never raises above the owner, always allows lowering', () => {
        expect(operatorModeAllowed('bypassPermissions', 'default')).toBe(false);
        expect(operatorModeAllowed('acceptEdits', 'default')).toBe(false);
        expect(operatorModeAllowed('plan', 'default')).toBe(true);
        expect(operatorModeAllowed('default', 'bypassPermissions')).toBe(true);
        expect(operatorModeAllowed('bypassPermissions', 'bypassPermissions')).toBe(true);
        expect(operatorModeAllowed('yolo', 'safe-yolo')).toBe(false);
    });
    it('an unknown owner mode is treated as default; an unknown target is refused', () => {
        expect(operatorModeAllowed('default', undefined)).toBe(true);
        expect(operatorModeAllowed('acceptEdits', null)).toBe(false);
        expect(operatorModeAllowed('mystery', 'bypassPermissions')).toBe(false);
    });
    it('offers flavor modes with the cap applied', () => {
        expect(operatorModeChoices('claude', 'default')).toEqual([
            { value: 'plan', allowed: true },
            { value: 'default', allowed: true },
            { value: 'acceptEdits', allowed: false },
            { value: 'bypassPermissions', allowed: false },
        ]);
        expect(operatorModeChoices('codex', 'yolo').every((c) => c.allowed)).toBe(true);
        expect(operatorModeChoices('codex', 'read-only').filter((c) => c.allowed).map((c) => c.value)).toEqual(['read-only']);
    });
});

describe('B-867 operator wire helpers', () => {
    it('allowlists the spec §3.1 session methods only', () => {
        for (const m of ['permission', 'abort', 'btw-ask', 'listDirectory', 'readFile', 'set-permission-mode']) expect(OPERATOR_SESSION_METHODS.has(m)).toBe(true);
        for (const m of ['killSession', 'conversation-rewind', 'switch', 'teams-adopt', 'claude-runtime-control', 'cancelQueuedMessage']) expect(OPERATOR_SESSION_METHODS.has(m)).toBe(false);
    });
    it('reads broker acks into a value or a stable code', () => {
        expect(readOperatorAck({ ok: true, result: 'abc' })).toEqual({ ok: true, result: 'abc' });
        expect(readOperatorAck({ ok: false, error: 'operator_mode_escalation' })).toEqual({ ok: false, code: 'operator_mode_escalation' });
        expect(readOperatorAck({ ok: true })).toEqual({ ok: false, code: 'rpc_failed' });
        expect(readOperatorAck(null)).toEqual({ ok: false, code: 'rpc_failed' });
        expect(readOperatorAck({ ok: false })).toEqual({ ok: false, code: 'rpc_failed' });
    });
    it('validates terminal frames', () => {
        expect(parseOperatorOutput({ sessionId: 's', terminalId: 't', data: 'x', seq: 3 })).toEqual({ sessionId: 's', terminalId: 't', data: 'x', seq: 3 });
        expect(parseOperatorOutput({ sessionId: 's', terminalId: 't', data: 'x' })).toEqual({ sessionId: 's', terminalId: 't', data: 'x' });
        expect(parseOperatorOutput({ sessionId: 's', terminalId: '', data: 'x' })).toBeNull();
        expect(parseOperatorOutput({ sessionId: 's', terminalId: 't', data: 'x', seq: 1.5 })).toBeNull();
        expect(parseOperatorExit({ sessionId: 's', terminalId: 't', exitCode: 0 })).toEqual({ sessionId: 's', terminalId: 't', exitCode: 0 });
        expect(parseOperatorExit({ sessionId: 's', terminalId: 't' })).toBeNull();
    });
    it('B-867b: the mode menu is bounded by the grant cap, not the mode the operator moved the session to', () => {
        // Operator lowered to plan under a default cap: default is offered again, acceptEdits is not.
        const bound = operatorModeBound({ modeCap: 'default' }, 'plan');
        expect(operatorModeChoices('claude', bound).filter((c) => c.allowed).map((c) => c.value)).toEqual(['plan', 'default']);
        // Pre-fix escalation left the session in bypass: the cap still says default.
        expect(operatorModeAllowed('bypassPermissions', operatorModeBound({ modeCap: 'default' }, 'bypassPermissions'))).toBe(false);
        // Server before B-867b: fall back to the mode in effect.
        expect(operatorModeBound({}, 'acceptEdits')).toBe('acceptEdits');
        expect(operatorModeBound(undefined, undefined)).toBeNull();
    });
});
