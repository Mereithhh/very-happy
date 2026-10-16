/** DEV-only (B-614 depth pass): the REAL SessionDetailScreen with one
 *  tool-heavy turn, a code block, thinking, a sub-agent, a pending permission
 *  request and the composer — the surfaces whose layering the depth pass
 *  changes. Route `/dev/depth/session/:id` (stripped from prod builds).
 *  Everything is a local example; nothing is sent. */
import { useEffect, useState } from 'react';
import { storage } from '@/sync/storage';
import type { NormalizedMessage } from '@/sync/typesRaw';
import type { Session } from '@/sync/storageTypes';
import { SessionDetailScreen } from '@/screens/session/SessionDetailScreen';
import '@/screens/session/session.css';

const SESSION_ID = 'dev-depth';
const BASE = Date.now() - 20 * 60_000;
let seq = 0;
function agent(content: unknown[], id = `d-${++seq}`): NormalizedMessage {
    return { role: 'agent', id, localId: null, createdAt: BASE + seq * 1000, isSidechain: false, seq, content } as unknown as NormalizedMessage;
}
function user(text: string): NormalizedMessage {
    seq++;
    return { role: 'user', id: `d-${seq}`, localId: null, createdAt: BASE + seq * 1000, isSidechain: false, seq, content: { type: 'text', text } } as unknown as NormalizedMessage;
}
const c = (o: Record<string, unknown>) => ({ uuid: `u-${seq}-${Math.random().toString(36).slice(2, 7)}`, parentUUID: null, ...o });
function call(id: string, name: string, input: Record<string, unknown>, result: string, isError = false): NormalizedMessage[] {
    return [agent([c({ type: 'tool-call', id, name, input, description: null })]), agent([c({ type: 'tool-result', tool_use_id: id, content: result, is_error: isError })])];
}

function messages(): NormalizedMessage[] {
    seq = 0;
    return [
        user('帮我看一下 sync/storage 的并发写入为什么偶尔丢消息，先别改生产配置。'),
        agent([c({ type: 'thinking', thinking: '先读 storage.ts 的写入路径，再看 reducer 的排序入口，最后跑相关测试确认。' })]),
        agent([c({ type: 'text', text: '先读写入路径和排序入口。' })]),
        ...call('t1', 'Read', { file_path: '/repo/packages/happy-web-v2/src/sync/storage.ts' }, '1\timport { create } from "zustand";\n2\t…'),
        ...call('t2', 'Grep', { pattern: 'sortIncomingBySeq', path: '/repo/packages/happy-web-v2/src' }, 'sync/storage.ts:212\nsync/reducer/reducer.ts:88'),
        ...call('t3', 'Bash', { command: 'pnpm -C packages/happy-web-v2 exec vitest run src/sync/storage.test.ts' }, ' ✓ src/sync/storage.test.ts (42 tests) 380ms\n\n Test Files  1 passed (1)\n      Tests  42 passed (42)'),
        ...call('t4', 'Task', { description: '复现并发写入丢消息', prompt: '用两个并发 applyMessages 复现。', subagent_type: 'Explore' }, 'done'),
        agent([c({ type: 'text', text: '问题在混批时没有按 seq 排序。最小修复如下：\n\n```ts\nexport function applyBatch(batch: Message[]) {\n  return sortIncomingBySeq(batch).forEach(apply); // 先排序再写入\n}\n```\n\n| 场景 | 修复前 | 修复后 |\n| --- | --- | --- |\n| 乱序混批 | 丢 1 条 | 0 |\n\n要我直接改并跑全量测试吗？' })]),
        user('改吧，跑一下全量测试。'),
        ...call('t5', 'Edit', { file_path: '/repo/packages/happy-web-v2/src/sync/storage.ts', old_string: 'batch.forEach(apply)', new_string: 'sortIncomingBySeq(batch).forEach(apply)' }, 'ok'),
        ...call('t6', 'Bash', { command: 'pnpm -C packages/happy-web-v2 exec tsc --noEmit' }, 'error TS2304: Cannot find name \'sortIncomingBySeq\'.', true),
        agent([c({ type: 'tool-call', id: 't7', name: 'Bash', input: { command: 'pnpm -C packages/happy-web-v2 exec vitest run' }, description: null })]),
    ];
}

export function DepthHarness() {
    const [ready, setReady] = useState(false);
    useEffect(() => {
        const now = Date.now();
        storage.getState().applySessions([{
            id: SESSION_ID, seq: 1, createdAt: now, updatedAt: now, active: true, activeAt: now,
            metadata: { machineId: 'dev-machine', path: '/repo', host: 'mac-office', flavor: 'claude', summary: { text: '排查 storage 并发写入丢消息', updatedAt: now },
                capabilities: ['claude-steer-v1', 'claude-live-permission-v1', 'claude-runtime-controls-v1'] },
            metadataVersion: 1,
            agentState: { controlledByUser: false, requests: { 'perm-1': { tool: 'Bash', arguments: { command: 'pnpm -C packages/happy-web-v2 exec vitest run', description: 'Run the full web test suite' }, createdAt: now } } },
            agentStateVersion: 1,
            thinking: true, thinkingAt: now, thinkingStartedAt: now - 14_000, presence: 'online',
        } as unknown as Session]);
        storage.getState().applyMessages(SESSION_ID, messages());
        storage.getState().applyMessagesLoaded(SESSION_ID);
        setReady(true);
    }, []);
    return ready ? <SessionDetailScreen /> : null;
}
