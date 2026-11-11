import { describe, expect, it, vi } from 'vitest';
import { guardOwnerAction, guardProjectChange, machineJoinRefusal, looseProjectChange, machineMayAct, ownerGuardMode, projectPermsGuardMode } from './ownerGuard';

const reply = () => { const send = vi.fn(); return { r: { code: vi.fn(() => ({ send })) } as any, send }; };

describe('B-927a owner guard modes', () => {
    it('OWNER_GUARD_MODE defaults to enforce; unknown values fall back to enforce', () => {
        expect(ownerGuardMode({})).toBe('enforce');
        expect(ownerGuardMode({ OWNER_GUARD_MODE: 'off' })).toBe('off');
        expect(ownerGuardMode({ OWNER_GUARD_MODE: ' Observe ' })).toBe('observe');
        expect(ownerGuardMode({ OWNER_GUARD_MODE: 'nope' })).toBe('enforce');
    });
    it('project permissions default to observe, enforce only when both switches say so', () => {
        expect(projectPermsGuardMode({})).toBe('observe');
        expect(projectPermsGuardMode({ OWNER_GUARD_PROJECT_PERMS: 'enforce' })).toBe('enforce');
        expect(projectPermsGuardMode({ OWNER_GUARD_PROJECT_PERMS: 'enforce', OWNER_GUARD_MODE: 'observe' })).toBe('observe');
        expect(projectPermsGuardMode({ OWNER_GUARD_PROJECT_PERMS: 'enforce', OWNER_GUARD_MODE: 'off' })).toBe('off');
    });
    it('a person always passes; a machine is refused only in enforce', () => {
        for (const mode of ['enforce', 'observe', 'off'] as const) {
            const { r } = reply();
            expect(guardOwnerAction({ authLoginSessionId: 'ls' }, r, 'x', mode)).toBe(true);
            expect(r.code).not.toHaveBeenCalled();
        }
        const enforced = reply();
        expect(guardOwnerAction({}, enforced.r, 'x', 'enforce')).toBe(false);
        expect(enforced.send).toHaveBeenCalledWith({ error: 'owner_login_required' });
        for (const mode of ['observe', 'off'] as const) { const { r } = reply(); expect(guardOwnerAction({}, r, 'x', mode)).toBe(true); expect(r.code).not.toHaveBeenCalled(); }
    });
});

describe('B-927a what a machine may still do on /actions', () => {
    const allowed = [
        { type: 'claim-operation' }, { type: 'complete-operation' }, { type: 'fail-operation' }, { type: 'session-event' }, { type: 'message-delivered' }, { type: 'join' },
        { type: 'archive', keepLeadSession: true }, { type: 'set-permission-mode', permissionMode: 'default' },
    ];
    const owner = [
        { type: 'accept' }, { type: 'return' }, { type: 'cancel' }, { type: 'handoff' }, { type: 'delegate' }, { type: 'message' }, { type: 'start' }, { type: 'set-defaults' },
        { type: 'set-bot-account' }, { type: 'schedule-create' }, { type: 'schedule-pause' }, { type: 'schedule-resume' }, { type: 'schedule-cancel' },
        { type: 'reconcile-operation' }, { type: 'retry-operation' }, { type: 'submit' }, { type: 'archive' }, { type: 'set-permission-mode', permissionMode: 'bypassPermissions' },
    ];
    it('daemon bookkeeping, join, archive keeping the Lead, and tightening are open', () => { for (const a of allowed) expect(machineMayAct(a as never), a.type).toBe(true); });
    it('everything else is the owner’s', () => { for (const a of owner) expect(machineMayAct(a as never), JSON.stringify(a)).toBe(false); });
});

describe('B-927a project loosening and seat takeover', () => {
    it('unknown permission modes and folder changes loosen; known tight modes and other fields do not', () => {
        expect(looseProjectChange({ defaults: { permissionMode: 'bypassPermissions' } })).toBe(true);
        expect(looseProjectChange({ defaults: { permissionMode: 'whatever' } })).toBe(true);
        expect(looseProjectChange({ folders: [] })).toBe(true);
        for (const mode of ['default', 'plan', 'read-only', null, undefined]) expect(looseProjectChange({ defaults: { permissionMode: mode } }), String(mode)).toBe(false);
        expect(looseProjectChange({ defaults: { model: 'x' } })).toBe(false);
        expect(looseProjectChange({})).toBe(false);
    });
    it('guardProjectChange observes by default for a machine', () => {
        const { r } = reply();
        expect(guardProjectChange({}, r, 'projects.update', { defaults: { permissionMode: 'yolo' } })).toBe(true);
        expect(r.code).not.toHaveBeenCalled();
    });
    it('a machine join naming a seat is refused unless it is the seat\'s own session; no botId is never refused', () => {
        const join = (sessionId: string, botId?: string) => ({ type: 'join', name: 'n', sessionId, ...(botId ? { botId } : {}) }) as never;
        const seats = (sessionId: string | null, root = true) => [{ id: 'bot', sessionId, root }];
        expect(machineJoinRefusal(join('b', 'bot'), seats('a'))).toBe('takeover');
        expect(machineJoinRefusal(join('b', 'bot'), seats(null))).toBe('takeover');
        expect(machineJoinRefusal(join('b', 'bot'), seats(null, false))).toBe('takeover');
        expect(machineJoinRefusal(join('b', 'bot'), seats('a', false))).toBe('takeover');
        expect(machineJoinRefusal(join('a', 'bot'), seats('a'))).toBeNull();
        expect(machineJoinRefusal(join('b'), seats('a'))).toBeNull();
        expect(machineJoinRefusal(join('b', 'missing'), seats('a'))).toBeNull();
    });
    it('an unknown OWNER_GUARD_PROJECT_PERMS value is enforce, not observe', () => {
        expect(projectPermsGuardMode({ OWNER_GUARD_PROJECT_PERMS: 'enfroce' } as never)).toBe('enforce');
        expect(projectPermsGuardMode({ OWNER_GUARD_PROJECT_PERMS: 'observe' } as never)).toBe('observe');
        expect(projectPermsGuardMode({} as never)).toBe('observe');
        expect(projectPermsGuardMode({ OWNER_GUARD_MODE: 'observe', OWNER_GUARD_PROJECT_PERMS: 'enfroce' } as never)).toBe('observe');
    });
});
