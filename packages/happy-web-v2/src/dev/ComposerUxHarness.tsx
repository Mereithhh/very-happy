/**
 * DEV-only harness (B-563 / B-564 / B-568): the real session column — ChatList,
 * SubagentDock, the pending-request dock (PermissionCard) and AgentInput in the
 * same `sd-foot` order SessionDetailScreen uses — fed by the real store.
 *
 * Controls on `window.__composerUx`:
 *   setRequests('bash' | 'ask' | 'both' | 'none')
 *   setSocket('connected' | 'disconnected')
 *   setTheme('light' | 'dark')
 *   setThinking(bool, requestsKind?)
 */
import { useEffect } from 'react';
import type { NormalizedMessage } from '@/sync/typesRaw';
import type { Session } from '@/sync/storageTypes';
import { storage } from '@/sync/storage';
import { ChatList } from '@/screens/session/ChatList';
import { SubagentDock } from '@/screens/session/SubagentDock';
import { PermissionCard } from '@/screens/session/PermissionCard';
import { AgentInput } from '@/screens/session/AgentInput';
import '@/screens/session/session.css';

const SESSION_ID = 'dev-composer-ux';
const BASE = 1_700_000_000_000;

const ASK = {
    tool: 'AskUserQuestion',
    arguments: {
        questions: [
            { header: '数据库', question: '用哪个数据库？', multiSelect: false, options: [{ label: 'Postgres', description: '生产同款' }, { label: 'SQLite', description: '本地最轻' }] },
            { header: '检查', question: '提交前跑哪些检查？', multiSelect: true, options: [{ label: 'lint', description: '风格检查' }, { label: 'test', description: '单元测试' }, { label: 'tsc', description: '类型检查' }] },
            { header: '发布', question: '合并后立即发布吗？', multiSelect: false, options: [{ label: '立即发布', description: '合并即发' }, { label: '等下一批', description: '随批次发布' }] },
        ],
    },
};
const BASH = { tool: 'Bash', arguments: { command: 'git push origin feat/orca3-composer --force-with-lease' } };

function requestsFor(kind: string): Record<string, unknown> {
    const now = Date.now();
    if (kind === 'bash') return { 'req-bash': { ...BASH, createdAt: now } };
    if (kind === 'ask') return { 'req-ask': { ...ASK, createdAt: now } };
    if (kind === 'both') return { 'req-bash': { ...BASH, createdAt: now }, 'req-ask': { ...ASK, createdAt: now + 1 } };
    return {};
}

function text(seq: number, role: 'user' | 'agent', body: string): NormalizedMessage {
    return {
        role,
        content: role === 'user' ? { type: 'text', text: body } : [{ type: 'text', text: body, uuid: `u-${seq}`, parentUUID: null }],
        id: `m-${seq}`,
        localId: null,
        createdAt: BASE + seq * 60_000,
        isSidechain: false,
        seq,
    } as unknown as NormalizedMessage;
}

let thinking = true;
function seed(kind: string) {
    const now = Date.now();
    storage.getState().applySessions([{
        id: SESSION_ID,
        seq: 1,
        createdAt: now,
        updatedAt: now,
        active: true,
        activeAt: now,
        metadata: {
            machineId: 'dev-machine', path: '/repo', host: 'dev', flavor: 'claude',
            claudeSessionId: '11111111-1111-4111-8111-111111111111',
            capabilities: ['claude-steer-v1', 'claude-live-permission-v1'],
        },
        metadataVersion: 1,
        agentState: { controlledByUser: false, requests: requestsFor(kind) },
        agentStateVersion: Date.now(),
        thinking,
        thinkingAt: now,
        thinkingStartedAt: now - 8000,
        presence: 'online',
    } as unknown as Session]);
}

declare global {
    interface Window {
        __composerUx?: {
            setRequests: (kind: string) => void;
            setSocket: (status: 'connected' | 'disconnected') => void;
            setTheme: (theme: 'light' | 'dark') => void;
            setThinking: (value: boolean, kind?: string) => void;
        };
    }
}

export function ComposerUxHarness() {
    useEffect(() => {
        seed('bash');
        const messages: NormalizedMessage[] = [];
        for (let seq = 1; seq <= 40; seq += 1) {
            messages.push(seq % 2 ? text(seq, 'user', `问题 ${seq}：解释第 ${seq} 个模块。`) : text(seq, 'agent', `回答 ${seq}：\n\n- 第一点说明。\n- 第二点说明。\n\n结论：模块 ${seq} 正常。`));
        }
        storage.getState().applyMessages(SESSION_ID, messages);
        storage.getState().applyMessagesLoaded(SESSION_ID);
        storage.getState().setSocketStatus('connected');
        window.__composerUx = {
            setRequests: seed,
            setSocket: (status) => storage.getState().setSocketStatus(status),
            setTheme: (theme) => { document.documentElement.dataset.theme = theme; },
            setThinking: (value, kind = 'none') => { thinking = value; seed(kind); },
        };
        return () => { delete window.__composerUx; };
    }, []);
    return (
        <div style={{ height: '100dvh', display: 'flex', flexDirection: 'column', background: 'var(--bg-0)', color: 'var(--text)' }}>
            <div className="sd" style={{ flex: 1, minHeight: 0 }}>
                <div className="sd-main">
                    <div className="sd-body">
                        <ChatList sessionId={SESSION_ID} />
                    </div>
                    <div className="sd-foot">
                        <SubagentDock sessionId={SESSION_ID} />
                        <PermissionCard key={SESSION_ID} sessionId={SESSION_ID} />
                        <AgentInput sessionId={SESSION_ID} />
                    </div>
                </div>
            </div>
        </div>
    );
}
