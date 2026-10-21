#!/usr/bin/env node
// B-629 test fixture: the smallest ACP agent (JSON-RPC over stdio) whose misbehaviour the
// backend must survive. The scenario is the first argument:
//   die-mid-prompt   answers initialize/session.new, streams one chunk, writes to stderr, exits 3
//   end-turn         answers the prompt with stopReason end_turn after one chunk (and a tool call
//                    that never completes — the turn still ends on the response)
//   exit-zero-idle   exits 0 right after session.new (an agent that quit between turns)
//   oversized        answers the prompt with a response line longer than the backend's cap
//   loadable         advertises loadSession; `session/load` of 'known-session' replays the earlier
//                    conversation (user + agent chunks, a tool call) then answers; any other id errors (B-633)
//   dialog-select    asks a pi extension select (pi-ui-*, choice-N) and echoes the outcome (B-632)
//   dialog-confirm   asks a pi extension confirm (yes/no) and echoes the outcome (B-632)
import { createInterface } from 'node:readline';

const scenario = process.argv[2] ?? 'end-turn';
const out = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
const notify = (sessionId, update) => out({ method: 'session/update', params: { sessionId, update } });

let pendingDialog = null;
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.method === 'initialize') {
        out({ id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: scenario === 'loadable', promptCapabilities: { image: false } } } });
        return;
    }
    if (msg.method === 'session/new') {
        out({ id: msg.id, result: { sessionId: 'fake-session' } });
        if (scenario === 'exit-zero-idle') setTimeout(() => process.exit(0), 20);
        return;
    }
    if (msg.method === 'session/load') {
        const sessionId = msg.params.sessionId;
        if (sessionId !== 'known-session') {
            out({ id: msg.id, error: { code: -32602, message: `Unknown sessionId: ${sessionId}` } });
            return;
        }
        notify(sessionId, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'earlier question' } });
        notify(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'earlier answer' } });
        notify(sessionId, { sessionUpdate: 'tool_call', toolCallId: 'old-call', title: 'old tool', kind: 'execute', status: 'completed' });
        notify(sessionId, { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'compact', description: 'c' }] });
        setTimeout(() => out({ id: msg.id, result: { models: { availableModels: [], currentModelId: 'm1' } } }), 10);
        return;
    }
    if (msg.id !== undefined && msg.method === undefined && pendingDialog) {
        const { sessionId, promptId } = pendingDialog;
        pendingDialog = null;
        const outcome = msg.result?.outcome;
        notify(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `dialog:${outcome?.outcome === 'selected' ? outcome.optionId : 'cancelled'}` } });
        out({ id: promptId, result: { stopReason: 'end_turn' } });
        return;
    }
    if (msg.method === 'session/prompt' && (scenario === 'dialog-select' || scenario === 'dialog-confirm')) {
        const sessionId = msg.params.sessionId;
        pendingDialog = { sessionId, promptId: msg.id };
        const select = scenario === 'dialog-select';
        out({ id: 9001, method: 'session/request_permission', params: {
            sessionId,
            toolCall: { toolCallId: 'pi-ui-7', title: select ? 'Pick a color' : 'Proceed?', kind: 'other', status: 'pending',
                rawInput: select ? { method: 'select', title: 'Pick a color', options: ['Red', 'Blue'] } : { method: 'confirm', title: 'Proceed?' } },
            options: select
                ? [{ optionId: 'choice-0', name: 'Red', kind: 'allow_once' }, { optionId: 'choice-1', name: 'Blue', kind: 'allow_once' }]
                : [{ optionId: 'yes', name: 'Yes', kind: 'allow_once' }, { optionId: 'no', name: 'No', kind: 'reject_once' }],
        } });
        return;
    }
    if (msg.method === 'session/prompt') {
        const sessionId = msg.params.sessionId;
        notify(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'working on it' } });
        if (scenario === 'die-mid-prompt') {
            process.stderr.write('FATAL ERROR: Reached heap limit Allocation failed\n');
            setTimeout(() => process.exit(3), 20);
            return;
        }
        if (scenario === 'oversized') {
            const padding = 'x'.repeat(Number(process.env.FAKE_ACP_OVERSIZE_CHARS ?? '300'));
            process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn', padding } })}\n`);
            return;
        }
        notify(sessionId, { sessionUpdate: 'tool_call', toolCallId: 'call-1', title: 'sleep forever', kind: 'execute', status: 'in_progress' });
        setTimeout(() => out({ id: msg.id, result: { stopReason: 'end_turn' } }), 30);
        return;
    }
    if (msg.method === 'session/cancel') {
        return;
    }
    if (msg.id !== undefined) {
        out({ id: msg.id, result: {} });
    }
});
rl.on('close', () => process.exit(0));
