#!/usr/bin/env node
// B-629 test fixture: the smallest ACP agent (JSON-RPC over stdio) whose misbehaviour the
// backend must survive. The scenario is the first argument:
//   die-mid-prompt   answers initialize/session.new, streams one chunk, writes to stderr, exits 3
//   end-turn         answers the prompt with stopReason end_turn after one chunk (and a tool call
//                    that never completes — the turn still ends on the response)
//   exit-zero-idle   exits 0 right after session.new (an agent that quit between turns)
//   oversized        answers the prompt with a response line longer than the backend's cap
import { createInterface } from 'node:readline';

const scenario = process.argv[2] ?? 'end-turn';
const out = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
const notify = (sessionId, update) => out({ method: 'session/update', params: { sessionId, update } });

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.method === 'initialize') {
        out({ id: msg.id, result: { protocolVersion: 1, agentCapabilities: { promptCapabilities: { image: false } } } });
        return;
    }
    if (msg.method === 'session/new') {
        out({ id: msg.id, result: { sessionId: 'fake-session' } });
        if (scenario === 'exit-zero-idle') setTimeout(() => process.exit(0), 20);
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
