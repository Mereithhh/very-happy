import { describe, expect, it, vi } from 'vitest';
import type { AgentMessage } from '@/agent/core';
import {
  ACP_RAW_INPUT_MAX_BYTES,
  ACP_TERMINAL_OUTPUT_MAX_BYTES,
  appendTerminalOutput,
  buildAcpBashResult,
  buildAcpPermissionMeta,
  deriveAcpToolArgs,
  readAcpTerminalMeta,
} from './acpToolArgs';
import { handleToolCall, handleToolCallUpdate, type HandlerContext } from './sessionUpdateHandlers';
import { AcpSessionManager } from './AcpSessionManager';

// Probed pi-acp 0.0.33 payloads (skills/tmp/vh-supervisor/ADDENDUM-batch3.md).
const probe = {
  bash: { sessionUpdate: 'tool_call', toolCallId: 'tc-bash', title: 'echo probe', kind: 'execute', status: 'pending', content: [{ type: 'terminal', terminalId: 'tc-bash' }] },
  read: { sessionUpdate: 'tool_call', toolCallId: 'tc-read', title: 'read', kind: 'read', status: 'in_progress', rawInput: { path: '/tmp/a.txt', limit: 10 }, locations: [{ path: '/tmp/a.txt' }] },
  write: { sessionUpdate: 'tool_call', toolCallId: 'tc-write', title: 'write', kind: 'edit', status: 'in_progress', rawInput: { path: '/tmp/b.txt', content: 'hi' } },
  edit: { sessionUpdate: 'tool_call', toolCallId: 'tc-edit', title: 'edit', kind: 'edit', status: 'in_progress', rawInput: { path: '/tmp/b.txt', oldText: 'a', newText: 'b' } },
  bridge: { sessionUpdate: 'tool_call', toolCallId: 'tc-spawn', title: 'session_spawn', kind: 'other', status: 'in_progress', rawInput: { prompt: 'go' } },
};

describe('deriveAcpToolArgs', () => {
  it('bash: kind execute → piTool bash + command from title, no rawInput', () => {
    expect(deriveAcpToolArgs(probe.bash)).toEqual({ acpTitle: 'echo probe', acpKind: 'execute', piTool: 'bash', command: 'echo probe' });
  });

  it('read/write/edit/other: piTool from title, rawInput passed through', () => {
    expect(deriveAcpToolArgs(probe.read)).toEqual({ acpTitle: 'read', acpKind: 'read', piTool: 'read', rawInput: { path: '/tmp/a.txt', limit: 10 } });
    expect(deriveAcpToolArgs(probe.write)).toEqual({ acpTitle: 'write', acpKind: 'edit', piTool: 'write', rawInput: { path: '/tmp/b.txt', content: 'hi' } });
    expect(deriveAcpToolArgs(probe.edit)).toEqual({ acpTitle: 'edit', acpKind: 'edit', piTool: 'edit', rawInput: { path: '/tmp/b.txt', oldText: 'a', newText: 'b' } });
    expect(deriveAcpToolArgs(probe.bridge)).toEqual({ acpTitle: 'session_spawn', acpKind: 'other', piTool: 'session_spawn', rawInput: { prompt: 'go' } });
  });

  it('missing title / non-identifier title → no piTool, never throws', () => {
    expect(deriveAcpToolArgs({ kind: 'read' })).toEqual({ acpKind: 'read' });
    expect(deriveAcpToolArgs({ title: 'Confirm: git push', kind: 'other' })).toEqual({ acpTitle: 'Confirm: git push', acpKind: 'other' });
    expect(deriveAcpToolArgs({ kind: 'execute' })).toEqual({ acpKind: 'execute', piTool: 'bash' });
    expect(deriveAcpToolArgs({ title: 42, kind: null, rawInput: [1] })).toEqual({});
    expect(deriveAcpToolArgs({})).toEqual({});
  });

  it('oversize rawInput is dropped with a rawInputTruncated marker', () => {
    const big = { content: 'x'.repeat(ACP_RAW_INPUT_MAX_BYTES + 1) };
    expect(deriveAcpToolArgs({ title: 'write', kind: 'edit', rawInput: big })).toEqual({ acpTitle: 'write', acpKind: 'edit', piTool: 'write', rawInputTruncated: true });
  });
});

describe('terminal meta helpers', () => {
  it('reads terminal_output.data and terminal_exit.exit_code', () => {
    expect(readAcpTerminalMeta({ _meta: { terminal_output: { terminal_id: 'x', data: 'out\n' } } })).toEqual({ outputDelta: 'out\n' });
    expect(readAcpTerminalMeta({ _meta: { terminal_exit: { terminal_id: 'x', exit_code: 3, signal: null } } })).toEqual({ exitCode: 3 });
    expect(readAcpTerminalMeta({ _meta: {} })).toEqual({});
    expect(readAcpTerminalMeta({})).toEqual({});
  });

  it('appendTerminalOutput keeps the tail within the cap', () => {
    const out = appendTerminalOutput('a'.repeat(ACP_TERMINAL_OUTPUT_MAX_BYTES), 'tail');
    expect(Buffer.byteLength(out)).toBe(ACP_TERMINAL_OUTPUT_MAX_BYTES);
    expect(out.endsWith('tail')).toBe(true);
  });

  it('buildAcpBashResult returns undefined without any bash signal', () => {
    expect(buildAcpBashResult(undefined, undefined)).toBeUndefined();
    expect(buildAcpBashResult('ok\n', 0)).toEqual({ text: 'ok\n', exitCode: 0 });
    expect(buildAcpBashResult(undefined, 1)).toEqual({ text: '', exitCode: 1 });
  });
});

describe('buildAcpPermissionMeta', () => {
  it('surfaces gate title and reason from pi-acp request_permission', () => {
    expect(buildAcpPermissionMeta({ title: 'ask-git-push', kind: 'other', rawInput: { method: 'confirm', title: 'ask-git-push', message: 'Pushing needs the owner' } }))
      .toEqual({ acpTitle: 'ask-git-push', acpKind: 'other', message: 'Pushing needs the owner' });
    expect(buildAcpPermissionMeta(undefined)).toEqual({});
    expect(buildAcpPermissionMeta({ title: '', rawInput: null })).toEqual({});
  });
});

function makeCtx(): { ctx: HandlerContext; emitted: AgentMessage[] } {
  const emitted: AgentMessage[] = [];
  const ctx: HandlerContext = {
    transport: { agentName: 'pi', getInitTimeout: () => 1000, getToolPatterns: () => [] },
    activeToolCalls: new Set(),
    toolCallStartTimes: new Map(),
    toolCallTimeouts: new Map(),
    toolCallIdToNameMap: new Map(),
    toolCallOutputs: new Map(),
    idleTimeout: null,
    toolCallCountSincePrompt: 0,
    emit: (msg) => emitted.push(msg),
    emitIdleStatus: vi.fn(),
    clearIdleTimeout: vi.fn(),
    setIdleTimeout: vi.fn(),
  };
  return { ctx, emitted };
}

describe('handleToolCall args shape (pi-acp probe payloads)', () => {
  it('keeps toolName = kind and adds the additive fields', () => {
    const { ctx, emitted } = makeCtx();
    for (const update of Object.values(probe)) handleToolCall(update, ctx);
    const calls = emitted.filter((m) => m.type === 'tool-call') as Extract<AgentMessage, { type: 'tool-call' }>[];
    expect(calls.map((c) => c.toolName)).toEqual(['execute', 'read', 'edit', 'edit', 'other']);
    expect(calls[0].args).toMatchObject({ items: probe.bash.content, piTool: 'bash', command: 'echo probe', acpTitle: 'echo probe', acpKind: 'execute' });
    expect(calls[1].args).toMatchObject({ piTool: 'read', rawInput: probe.read.rawInput, locations: probe.read.locations });
    expect(calls[2].args).toMatchObject({ piTool: 'write', rawInput: probe.write.rawInput });
    expect(calls[3].args).toMatchObject({ piTool: 'edit', rawInput: probe.edit.rawInput });
    expect(calls[4].args).toMatchObject({ piTool: 'session_spawn', rawInput: probe.bridge.rawInput });
    for (const t of ctx.toolCallTimeouts.values()) clearTimeout(t);
  });

  it('accumulates bash _meta terminal output and emits it on completion', () => {
    const { ctx, emitted } = makeCtx();
    handleToolCall(probe.bash, ctx);
    handleToolCallUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 'tc-bash', status: 'in_progress', _meta: {} }, ctx);
    handleToolCallUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 'tc-bash', status: 'in_progress', _meta: { terminal_output: { terminal_id: 'tc-bash', data: 'pro' } } }, ctx);
    handleToolCallUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 'tc-bash', status: 'in_progress', _meta: { terminal_output: { terminal_id: 'tc-bash', data: 'be\n' } } }, ctx);
    handleToolCallUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 'tc-bash', status: 'completed', _meta: { terminal_exit: { terminal_id: 'tc-bash', exit_code: 2, signal: null } } }, ctx);
    const result = emitted.find((m) => m.type === 'tool-result') as Extract<AgentMessage, { type: 'tool-result' }>;
    expect(result.result).toEqual({ text: 'probe\n', exitCode: 2 });
    expect(ctx.toolCallOutputs.size).toBe(0);
    expect(emitted.filter((m) => m.type === 'tool-call')).toHaveLength(1);
  });

  it('non-bash completion keeps the ACP content as result (unchanged path)', () => {
    const { ctx, emitted } = makeCtx();
    handleToolCall(probe.read, ctx);
    const content = [{ type: 'content', content: { type: 'text', text: 'file body' } }];
    handleToolCallUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 'tc-read', status: 'completed', content }, ctx);
    const result = emitted.find((m) => m.type === 'tool-result') as Extract<AgentMessage, { type: 'tool-result' }>;
    expect(result.result).toBe(content);
  });
});

describe('AcpSessionManager tool-call-end result', () => {
  it('carries bash text/isError on the wire; other results stay off the wire', () => {
    const mapper = new AcpSessionManager();
    mapper.startTurn();
    mapper.mapMessage({ type: 'tool-call', toolName: 'execute', args: {}, callId: 'tc-bash' });
    const [bashEnd] = mapper.mapMessage({ type: 'tool-result', toolName: 'execute', result: { text: 'oops', exitCode: 1 }, callId: 'tc-bash' });
    expect(bashEnd.ev).toMatchObject({ t: 'tool-call-end', result: { text: 'oops\n[exit code 1]', isError: true } });

    mapper.mapMessage({ type: 'tool-call', toolName: 'execute', args: {}, callId: 'tc-ok' });
    const [okEnd] = mapper.mapMessage({ type: 'tool-result', toolName: 'execute', result: { text: 'fine\n', exitCode: 0 }, callId: 'tc-ok' });
    expect(okEnd.ev).toEqual({ t: 'tool-call-end', call: expect.any(String), result: { text: 'fine\n' } });

    mapper.mapMessage({ type: 'tool-call', toolName: 'read', args: {}, callId: 'tc-read' });
    const [readEnd] = mapper.mapMessage({ type: 'tool-result', toolName: 'read', result: [{ type: 'content' }], callId: 'tc-read' });
    expect(readEnd.ev).toEqual({ t: 'tool-call-end', call: expect.any(String) });
  });
});
