/** DEV-only (B-865): the one-search-entry scene for `/dev/device#search`.
 *  `dev-machine` answers `history-search` in-page (setContentSearchOverride) —
 *  「zebracorn」 is a word only its transcript index holds, in the plain
 *  session's conversation (tracked via claudeSessionId); `dev-laptop` is
 *  offline and owns an archived session, so the content group reports it and
 *  the status filter has something to include. Nothing is sent. */
import { storage } from '@/sync/storage';
import type { Machine, Session } from '@/sync/storageTypes';
import type { NormalizedMessage } from '@/sync/typesRaw';
import { parseHistorySearch } from '@/screens/sessions/historySearch';
import { setContentSearchOverride } from '@/screens/search/useContentSearch';
import * as chatJump from '@/screens/search/chatJump';
import { PLAIN_SESSION_ID } from './plainSessionSeed';

export const SEARCH_ONLY_WORD = 'zebracorn';
export const SEARCH_SESSION_ID = 'dev-search';
/** In an early prompt of SEARCH_SESSION_ID only — a jump lands mid-transcript on it. */
export const PROMPT_ONLY_WORD = 'rollout-flag';
const PLAIN_CLAUDE_ID = '5e1ec7ed-0000-4000-8000-00000000b865';
const ZH = typeof navigator === 'undefined' || navigator.language.toLowerCase().startsWith('zh');
const L = (zh: string, en: string) => (ZH ? zh : en);

function searchTranscript(base: number): NormalizedMessage[] {
    const turns = [
        [L(`先给支付回调加一个 ${PROMPT_ONLY_WORD}，默认关闭。`, `Add a ${PROMPT_ONLY_WORD} to the payment callback, off by default.`), L('已加上，默认关闭，配置项在 config/payments.ts。', 'Added, off by default; the setting lives in config/payments.ts.')],
        ...Array.from({ length: 16 }, (_, i) => [L(`第 ${i + 2} 步：补一组重试测试。`, `Step ${i + 2}: add another retry test.`), L('测试已补上，全部通过。', 'Tests added; all pass.')]),
    ];
    return turns.flatMap(([q, a], i) => [
        { role: 'user', id: `s-${i}-q`, localId: `search-q${i}`, createdAt: base + i * 120_000, isSidechain: false, seq: i * 2 + 1, content: { type: 'text', text: q } },
        { role: 'agent', id: `s-${i}-a`, localId: null, createdAt: base + i * 120_000 + 60_000, isSidechain: false, seq: i * 2 + 2,
            content: [{ type: 'text', text: a, uuid: `su-${i}`, parentUUID: null }] },
    ]) as unknown as NormalizedMessage[];
}

export function seedSearchScene(): () => void {
    const now = Date.now();
    const plain = storage.getState().sessions[PLAIN_SESSION_ID];
    storage.getState().applyMachines([
        { id: 'dev-machine', seq: 3, createdAt: now, updatedAt: now, active: true, activeAt: now, metadata: { host: 'dev-box', platform: 'linux', teamLaunchVersion: 1 }, metadataVersion: 1,
            daemonState: { startedAt: 1, historySearch: { rpcAvailable: true, detectedAt: 2 } }, daemonStateVersion: 1 },
        { id: 'dev-laptop', seq: 1, createdAt: now, updatedAt: now - 86_400_000, active: false, activeAt: now - 86_400_000, metadata: { host: 'old-laptop', platform: 'darwin' }, metadataVersion: 1, daemonState: null, daemonStateVersion: 1 },
    ] as unknown as Machine[]);
    storage.getState().applySessions([
        ...(plain ? [{ ...plain, metadata: { ...plain.metadata, claudeSessionId: PLAIN_CLAUDE_ID } }] : []),
        { id: 'dev-archived', seq: 1, createdAt: now - 3 * 86_400_000, updatedAt: now - 2 * 86_400_000, active: false, activeAt: now - 2 * 86_400_000,
            metadata: { machineId: 'dev-laptop', path: '/repo/old', host: 'old-laptop', flavor: 'claude', summary: { text: L('旧的构建实验', 'Old build experiment'), updatedAt: now } },
            metadataVersion: 1, agentState: null, agentStateVersion: 1, thinking: false, presence: 'offline' },
        { id: SEARCH_SESSION_ID, seq: 1, createdAt: now - 3 * 3600_000, updatedAt: now - 30 * 60_000, active: true, activeAt: now - 30 * 60_000,
            metadata: { machineId: 'dev-machine', path: '/repo/payments', host: 'dev-box', flavor: 'claude', summary: { text: L('支付回调重试', 'Payment callback retries'), updatedAt: now } },
            metadataVersion: 1, agentState: { controlledByUser: false, requests: {} }, agentStateVersion: 1, thinking: false, presence: 'online' },
    ] as unknown as Session[]);
    // Once per page (a remount must keep the ids a pending jump points at).
    if (!storage.getState().sessionMessages[SEARCH_SESSION_ID]?.messages?.length) {
        storage.getState().applyMessages(SEARCH_SESSION_ID, searchTranscript(now - 3 * 3600_000));
        storage.getState().applyMessagesLoaded(SEARCH_SESSION_ID);
    }
    // The app's own chat-jump module (e2e/unified-search.mjs reads the request a click makes).
    (window as unknown as { __vhChatJump: typeof chatJump }).__vhChatJump = chatJump;
    const calls: string[] = [];
    (window as unknown as { __vhSearchCalls: string[] }).__vhSearchCalls = calls;
    setContentSearchOverride(async (_machineId, params) => {
        calls.push(params.query ?? '');
        await new Promise((r) => setTimeout(r, 400));
        const q = (params.query ?? '').toLowerCase();
        const text = L(`我们把这个组件叫 ${SEARCH_ONLY_WORD}，先别改它的接口。`, `We call this component ${SEARCH_ONLY_WORD}; keep its interface for now.`);
        const at = text.toLowerCase().indexOf(SEARCH_ONLY_WORD);
        const results = q.split(/\s+/).every((t) => text.toLowerCase().includes(t))
            ? [{ agent: 'claude', id: PLAIN_CLAUDE_ID, title: L('修复构建里的类型错误', 'Fix the type errors in the build'), updatedAt: now - 60_000, cwd: '/repo/app', matchCount: 1,
                snippets: [{ role: 'user', text, ranges: [[at, at + SEARCH_ONLY_WORD.length]], at: now - 80 * 60_000 }] }]
            : [];
        return { ok: true, ...parseHistorySearch({ status: { state: 'ready' }, results }) };
    });
    return () => setContentSearchOverride(null);
}
