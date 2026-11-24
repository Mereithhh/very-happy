import { describe, expect, it } from 'vitest';
import {
    DSH_COMPACT_NOTICE,
    DSH_INSTALL_COMMAND,
    dshAutoApproves,
    dshContextUsageOf,
    dshFailureHint,
    dshPrerequisiteProblem,
    dshSetupMessage,
    dshSpawnRefusal,
    nodeMeetsDshMinimum,
    parseNodeVersion,
} from './dshRunner';
import { resolveAcpAgentConfig } from './acpAgentConfig';

describe('dsh runner prerequisites (B-952)', () => {
    it('parses node --version output', () => {
        expect(parseNodeVersion('v24.9.0\n')).toEqual([24, 9, 0]);
        expect(parseNodeVersion('22.23.2')).toEqual([22, 23, 2]);
        expect(parseNodeVersion('')).toBeNull();
        expect(parseNodeVersion(null)).toBeNull();
        expect(parseNodeVersion('node: not found')).toBeNull();
    });

    it('requires Node 24.9 or newer', () => {
        expect(nodeMeetsDshMinimum('v24.9.0')).toBe(true);
        expect(nodeMeetsDshMinimum('v24.22.3')).toBe(true);
        expect(nodeMeetsDshMinimum('v25.0.0')).toBe(true);
        expect(nodeMeetsDshMinimum('v24.8.9')).toBe(false);
        expect(nodeMeetsDshMinimum('v22.23.2')).toBe(false);
        expect(nodeMeetsDshMinimum(null)).toBe(false);
    });

    it('reports a missing dsh before the Node version, and nothing when both are fine', () => {
        expect(dshPrerequisiteProblem(false, 'v24.9.0')).toEqual({ kind: 'missing' });
        expect(dshPrerequisiteProblem(true, 'v22.23.2\n')).toEqual({ kind: 'node-too-old', nodeVersion: 'v22.23.2' });
        expect(dshPrerequisiteProblem(true, null)).toEqual({ kind: 'node-too-old', nodeVersion: null });
        expect(dshPrerequisiteProblem(true, 'v24.9.1')).toBeNull();
    });

    it('says exactly how to fix each problem', () => {
        expect(dshSetupMessage({ kind: 'missing' })).toContain(DSH_INSTALL_COMMAND);
        const old = dshSetupMessage({ kind: 'node-too-old', nodeVersion: 'v22.23.2' });
        expect(old).toContain('Node.js 24.9.0 or newer');
        expect(old).toContain('Node.js v22.23.2');
        expect(old).toContain('nvm install 24');
        expect(dshSetupMessage({ kind: 'node-too-old', nodeVersion: null })).toContain('no Node.js');
        expect(dshSpawnRefusal({ kind: 'missing' })).toContain(DSH_INSTALL_COMMAND);
        expect(dshSpawnRefusal({ kind: 'node-too-old', nodeVersion: 'v22.1.0' })).toContain('v22.1.0');
    });

    it('turns dsh failures into actionable hints and leaves the rest alone', () => {
        expect(dshFailureHint('spawn dsh ENOENT')).toContain(DSH_INSTALL_COMMAND);
        expect(dshFailureHint('llm-deepseek: no API key for provider route "deepseek-official"')).toContain('DEEPSEEK_API_KEY');
        expect(dshFailureHint('MISSING_CREDENTIAL')).toContain('no API key');
        expect(dshFailureHint('https://api.deepseek.com/models answered HTTP 401')).toContain('rejected the API key');
        // dsh 0.2.2-rc.5's real turn failure for a bad key (key masked by dsh).
        expect(dshFailureHint('Internal error: turn failed: Authentication Fails, Your api key: ****abcd is invalid')).toContain('rejected the API key');
        // dsh 0.2.2-rc.5's real turn failure for a key with no balance.
        expect(dshFailureHint('Internal error: turn failed: Insufficient Balance (request_id: x)')).toContain('no balance');
        expect(dshFailureHint('spawn pi-acp ENOENT')).toBeNull();
        expect(dshFailureHint('some other failure')).toBeNull();
        expect(dshFailureHint(undefined)).toBeNull();
    });

    it('auto-approves permission asks only in bypass mode', () => {
        expect(dshAutoApproves('bypassPermissions')).toBe(true);
        expect(dshAutoApproves('yolo')).toBe(true);
        expect(dshAutoApproves('default')).toBe(false);
        expect(dshAutoApproves('acceptEdits')).toBe(false);
        expect(dshAutoApproves('plan')).toBe(false);
        expect(dshAutoApproves(undefined)).toBe(false);
    });

    it('runs the ACP profile of dsh', () => {
        expect(resolveAcpAgentConfig(['dsh'])).toEqual({ agentName: 'dsh', command: 'dsh', args: ['--profile', 'acp'] });
    });
});

describe('dsh tool kinds (B-952)', () => {
    it('maps dsh tool names to standard ACP kinds for the Web tool cards', async () => {
        const { dshToolKind } = await import('./dshRunner');
        const { deriveAcpToolArgs } = await import('./acpToolArgs');
        expect(dshToolKind('bash')).toBe('execute');
        expect(dshToolKind('read')).toBe('read');
        expect(dshToolKind('apply_patch')).toBe('edit');
        expect(dshToolKind('grep')).toBe('search');
        expect(dshToolKind('web_fetch')).toBe('fetch');
        expect(dshToolKind('todo_write')).toBeNull();
        expect(dshToolKind('constructor')).toBeNull();
        expect(deriveAcpToolArgs({ title: 'bash', kind: 'other', rawInput: { command: 'ls' } }, { agentName: 'dsh' }))
            .toEqual({ acpTitle: 'bash', acpKind: 'execute', rawInput: { command: 'ls' } });
        expect(deriveAcpToolArgs({ title: 'subagent', kind: 'other' }, { agentName: 'dsh' })).toEqual({ acpTitle: 'subagent', acpKind: 'other' });
        // Other agents keep the kind they sent.
        expect(deriveAcpToolArgs({ title: 'bash', kind: 'other' }, { agentName: 'opencode' }).acpKind).toBe('other');
    });
});

describe('dsh pending permission request shape (B-969)', () => {
  it('dsh requests are kind tool (Web hides "Approve for session": dsh only grants allow-once)', async () => {
    const { acpPendingRequestExtras } = await import('./dshRunner');
    expect(acpPendingRequestExtras('dsh')).toEqual({ kind: 'tool' });
    for (const agent of ['pi', 'gemini', 'opencode', 'acp']) expect(acpPendingRequestExtras(agent)).toEqual({});
  });

  it('BasePermissionHandler stores the extras next to tool / arguments, and nothing for others', async () => {
    const { BasePermissionHandler } = await import('@/utils/BasePermissionHandler');
    const { acpPendingRequestExtras } = await import('./dshRunner');
    let state: any = {};
    const session = {
      rpcHandlerManager: { registerHandler: () => {} },
      updateAgentState: (fn: (s: any) => any) => { state = fn(state); },
    };
    class H extends BasePermissionHandler {
      protected getLogPrefix() { return '[t]'; }
      add(id: string, agent: string) { this.addPendingRequestToState(id, 'bash', { command: 'ls' }, acpPendingRequestExtras(agent)); }
    }
    const h = new H(session as any);
    h.add('a', 'dsh');
    h.add('b', 'gemini');
    expect(state.requests.a).toMatchObject({ tool: 'bash', arguments: { command: 'ls' }, kind: 'tool' });
    expect(state.requests.a.permissionSuggestions).toBeUndefined();
    expect('kind' in state.requests.b).toBe(false);
  });
});

describe('switching a dsh session to auto-approve (B-969)', () => {
  it('approveAllPending resolves waiting asks as approved and moves them to completedRequests', async () => {
    const { BasePermissionHandler } = await import('@/utils/BasePermissionHandler');
    let state: any = {};
    const session = {
      rpcHandlerManager: { registerHandler: () => {} },
      updateAgentState: (fn: (s: any) => any) => { state = fn(state); },
    };
    class H extends BasePermissionHandler {
      protected getLogPrefix() { return '[t]'; }
      ask(id: string) {
        return new Promise((resolve, reject) => {
          this.pendingRequests.set(id, { resolve, reject, toolName: 'bash', input: {} });
          this.addPendingRequestToState(id, 'bash', { command: 'ls' }, { kind: 'tool' });
        });
      }
    }
    const h = new H(session as any);
    expect(h.approveAllPending()).toEqual([]);
    const a = h.ask('a');
    const b = h.ask('b');
    expect(h.approveAllPending('why').map((r) => r.id)).toEqual(['a', 'b']);
    await expect(a).resolves.toEqual({ decision: 'approved' });
    await expect(b).resolves.toEqual({ decision: 'approved' });
    expect(state.requests).toEqual({});
    expect(state.completedRequests.a).toMatchObject({ tool: 'bash', status: 'approved', decision: 'approved', kind: 'tool', reason: 'why' });
    expect(h.approveAllPending()).toEqual([]);
  });

  it('the dsh wrapper advertises live permission switching and approves waiting asks on bypass', async () => {
    const { DSH_LIVE_PERMISSION_CAPABILITY } = await import('./dshRunner');
    expect(DSH_LIVE_PERMISSION_CAPABILITY).toBe('dsh-live-permission-v1');
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('./runAcp.ts', import.meta.url), 'utf8');
    expect(src).toContain("...(opts.agentName === 'dsh' ? [DSH_LIVE_PERMISSION_CAPABILITY] : [])");
    expect(src).toContain("if (opts.agentName === 'dsh' && dshAutoApproves(mode)) {");
    expect(src).toContain('const notice = dshAutoApprovedNotice(permissionHandler?.approveAllPending(DSH_AUTO_APPROVED_REASON) ?? []);');
    expect(src).toContain("if (notice) session.sendSessionEvent({ type: 'message', message: notice });");
  });

  it('the transcript line names what was auto-approved', async () => {
    const { dshAutoApprovedNotice } = await import('./dshRunner');
    expect(dshAutoApprovedNotice([])).toBeNull();
    expect(dshAutoApprovedNotice([{ toolName: 'bash', input: { command: 'echo  a\n b' } }]))
      .toBe('Auto-approved the waiting request after switching to Auto-run — bash: echo a b');
    expect(dshAutoApprovedNotice([{ toolName: 'write', input: { file_path: '/tmp/x' } }, { toolName: 'todo', input: {} }]))
      .toBe('Auto-approved 2 waiting requests after switching to Auto-run — write: /tmp/x; todo');
    expect(dshAutoApprovedNotice([{ toolName: 'bash', input: { command: 'x'.repeat(400) } }])!.length).toBeLessThan(260);
  });
});

describe('dsh context usage (B-970)', () => {
    it('ties a usage_update to the dsh session it measured', () => {
        expect(dshContextUsageOf({ sessionUpdate: 'usage_update', used: 900, size: 1_000_000 }, 'dsh-1', 7)).toEqual({ sessionId: 'dsh-1', tokens: 900, contextWindow: 1_000_000, updatedAt: 7 });
    });

    it('drops a payload without a measurement or before the session id is known', () => {
        expect(dshContextUsageOf({ used: 900, size: 1_000_000 }, null, 7)).toBeNull();
        expect(dshContextUsageOf({ used: 900 }, 'dsh-1', 7)).toBeNull();
        expect(dshContextUsageOf(undefined, 'dsh-1', 7)).toBeNull();
    });
});

describe('dsh /compact notice (B-970)', () => {
    it('is the exact line the web translates (goalNotice.ts DSH_COMPACT_NOTICE)', () => {
        expect(DSH_COMPACT_NOTICE).toBe('DeepSeek Harness compacts the context automatically when it reaches about 80%; it has no manual compact command.');
    });
});
