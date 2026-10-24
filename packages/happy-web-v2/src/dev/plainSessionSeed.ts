/** DEV-only (B-798 PR F): an ordinary session beside the 汇报板 lead — not in a
 *  team, board capability but no items (P2-1: the phone strip stays away), and
 *  a long transcript of prompts and failed Bash cards so the prompt nav can sit
 *  over a tool-output copy overlay (P1-7). Neutral local example. */
import { storage } from '@/sync/storage';
import type { NormalizedMessage } from '@/sync/typesRaw';
import type { Session } from '@/sync/storageTypes';
import { ATTENTION_SESSION_CAPABILITY } from '@slopus/happy-wire';

export const PLAIN_SESSION_ID = 'dev-plain';
const ZH = typeof navigator === 'undefined' || navigator.language.toLowerCase().startsWith('zh');
const L = (zh: string, en: string) => (ZH ? zh : en);

function transcript(base: number): NormalizedMessage[] {
    const out: NormalizedMessage[] = [];
    let seq = 0;
    const at = () => base + seq * 60_000;
    for (let turn = 1; turn <= 5; turn++) {
        seq++;
        out.push({ role: 'user', id: `p-${seq}`, localId: `plain-q${turn}`, createdAt: at(), isSidechain: false, seq,
            content: { type: 'text', text: L(`第 ${turn} 轮：跑一下构建，看看哪里报错。`, `Turn ${turn}: run the build and see what fails.`) } } as unknown as NormalizedMessage);
        seq++;
        const call = `plain-call-${turn}`;
        out.push({ role: 'agent', id: `p-${seq}`, localId: null, createdAt: at(), isSidechain: false, seq,
            content: [{ type: 'tool-call', id: call, name: 'Bash', input: { command: `pnpm -C packages/app build --filter step-${turn}` }, description: null, uuid: `tc-${call}`, parentUUID: null }] } as unknown as NormalizedMessage);
        seq++;
        const stderr = Array.from({ length: 14 }, (_, i) => `src/module-${turn}/file-${i + 1}.ts(${i + 3},7): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.`).join('\n');
        out.push({ role: 'agent', id: `p-${seq}`, localId: null, createdAt: at(), isSidechain: false, seq,
            content: [{ type: 'tool-result', tool_use_id: call, content: stderr, is_error: true, uuid: `tr-${call}`, parentUUID: null }] } as unknown as NormalizedMessage);
        seq++;
        out.push({ role: 'agent', id: `p-${seq}`, localId: null, createdAt: at(), isSidechain: false, seq,
            content: [{ type: 'text', text: L('构建失败：14 处类型错误，都在参数类型上。下一轮先修 module 里的调用点。', 'Build failed: 14 type errors, all argument types. Next turn fixes the call sites first.'), uuid: `u-${seq}`, parentUUID: null }] } as unknown as NormalizedMessage);
    }
    return out;
}

export function seedPlainSession(): void {
    const now = Date.now();
    const base = now - 90 * 60_000;
    storage.getState().applySessions([{
        id: PLAIN_SESSION_ID, seq: 1, createdAt: base, updatedAt: now - 60_000, active: true, activeAt: now,
        metadata: { machineId: 'dev-machine', path: '/repo/app', host: 'dev-box', flavor: 'claude', summary: { text: L('修复构建里的类型错误', 'Fix the type errors in the build'), updatedAt: now },
            capabilities: ['claude-steer-v1', 'claude-live-permission-v1', ATTENTION_SESSION_CAPABILITY] },
        metadataVersion: 1,
        agentState: { controlledByUser: false, requests: {} },
        agentStateVersion: 1,
        thinking: false, presence: 'online', modelMode: 'sonnet',
    } as unknown as Session]);
    storage.getState().applyMessages(PLAIN_SESSION_ID, transcript(base));
    storage.getState().applyMessagesLoaded(PLAIN_SESSION_ID);
}
