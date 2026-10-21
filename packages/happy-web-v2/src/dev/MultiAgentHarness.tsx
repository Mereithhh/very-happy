/** DEV-only visual harness for every surface where agents interact (B-614):
 *  in-session sub-agents, Codex child threads, Teams, and session peer
 *  messages. Route is `/dev/multi-agent/:id` (stripped from prod builds) so
 *  rows see a session id and take their real drawer/pointer paths.
 *  All data below is a local example; nothing is sent or read remotely
 *  (the Codex child RPC is answered in-page). */
import { useEffect, useState } from 'react';
import type { TeamState } from '@slopus/happy-wire';
import { storage } from '@/sync/storage';
import { apiSocket } from '@/sync/apiSocket';
import { recordBackgroundTasks, recordHeartbeat } from '@/sync/heartbeatLease';
import type { Message, ToolCallMessage, UserTextMessage } from '@/sync/typesMessage';
import { ToolGroupView } from '@/screens/session/ToolGroupView';
import { TurnActivityView } from '@/screens/session/TurnActivityView';
import { MessageView } from '@/screens/session/MessageView';
import { SubagentDock } from '@/screens/session/SubagentDock';
import { SubagentPanel } from '@/screens/session/SubagentPanel';
import { onSubagentOpen } from '@/screens/session/subagentPanelState';
import { TeamMessageCardView } from '@/screens/session/TeamMessageCard';
import { presentTeamMessage } from '@/screens/session/teamMessage';
import { SessionTeamContextView } from '@/screens/session/SessionTeamContext';
import { TeamWorkspace, TeamListCard } from '@/screens/teams/TeamWorkspace';
import '@/screens/session/session.css';
import '@/screens/session/input.css';
import '@/screens/session/chatlist.css';
import '@/screens/teams/teams.css';

const SESSION_ID = 'dev-multi-agent';
const NOW = Date.now();

function tool(id: string, name: string, input: Record<string, unknown>, state: ToolCallMessage['tool']['state'] = 'completed', extra: Partial<ToolCallMessage> = {}): ToolCallMessage {
    return {
        kind: 'tool-call', id, localId: null, createdAt: NOW, children: [],
        tool: { name, state, input, createdAt: NOW, startedAt: NOW, completedAt: state === 'running' ? null : NOW + 42_000, description: null },
        ...extra,
    };
}

function task(id: string, description: string, status: 'running' | 'completed' | 'failed' | 'stopped' | null, subagentType = 'general-purpose', extra: Record<string, unknown> = {}): ToolCallMessage {
    const children: Message[] = [
        { kind: 'agent-text', id: `${id}-text`, localId: null, createdAt: NOW - 1, text: '先核对配置，再汇总检查结果。', meta: { reportedModel: 'claude-haiku-4-5-20251001' } as never },
        ...Array.from({ length: 6 }, (_, i) => tool(`${id}-c${i}`, 'Bash', { command: `git diff --stat -- src/module-${i}.ts` })),
    ];
    return tool(id, 'Task', {
        sessionSubagent: `sub-${id}`, model: 'haiku', subagent_type: subagentType, description,
        prompt: '检查项目配置，确认当前限制与配置来源。\n\n- 核对配置文件与实际生效值\n- 记录发现的问题和验证依据\n- 汇总结果，先不要修改生产配置',
    }, status === 'running' ? 'running' : status === 'failed' ? 'error' : 'completed', {
        children,
        ...(status ? { subagent: { status, subagentType, updatedAt: NOW, ...extra } as ToolCallMessage['subagent'] } : {}),
    });
}

const SUBAGENTS: ToolCallMessage[] = [
    task('sa-running', '查 API Platform TPM 配置', 'running', 'Explore'),
    task('sa-done', '审阅 sync/storage 的并发写入', 'completed', 'general-purpose', { result: { text: '## 结论\n\nTPM 可以安全提到 200000。' }, usage: { toolUses: 6, totalTokens: 41200, durationMs: 42_000 } }),
    task('sa-failed', '复现移动端输入框遮挡问题（需要真机，iOS Safari 17 + 外接键盘）', 'failed'),
    task('sa-stopped', '批量重命名测试快照', 'stopped'),
    task('sa-legacy', '旧 CLI：没有生命周期事件的子代理', null),
];

const CODEX: ToolCallMessage = tool('codex-spawn', 'CodexCollaboration', {
    operation: 'spawn', prompt: '在 packages/happy-cli 里补齐 codex 子线程的 abort 回归测试。', model: 'gpt-5-codex',
    receiverThreadIds: ['019a2b7c-thread-review', '019a2b7d-thread-tests'], agentsStates: {},
}, 'completed');

const EVENTS: Message[] = [
    { kind: 'agent-event', id: 'ev-run', createdAt: NOW, event: { type: 'subagent', id: 'codex-sub-1', status: 'running', title: 'Review diff' } as never },
    { kind: 'agent-event', id: 'ev-done', createdAt: NOW, event: { type: 'subagent', id: 'codex-sub-1', status: 'completed', title: 'Review diff' } as never },
    { kind: 'user-text', id: 'notif', localId: null, createdAt: NOW, text: '<task-notification>\n<status>completed</status>\n<summary>Background agent "审阅 sync/storage" finished</summary>\n</task-notification>' },
];

function peer(id: string, text: string): UserTextMessage {
    return { kind: 'user-text', id, localId: null, createdAt: NOW, text, meta: { sentFrom: 'session-peer' } as never };
}
const FOOT = '\n\nThis message comes from another agent session on this machine, not from the user.';
const PEERS: Message[] = [
    peer('peer-msg', `[Very Happy session message m1 from "修复 relay 断线重连" cmh2x9relay01; agent claude; cwd /Users/dev/very-happy]\n### 重连退避已改\n我改完了 \`apiSocket\` 的**重连退避**：\n1. 首次 1s，上限 30s\n2. 恢复后立即 checkLiveness\n\n| 场景 | 修前 | 修后 |\n|---|---|---|\n| 断网 10s | 30s 才恢复 | 1s |\n\n你那边的 sync 测试可以重跑了。${FOOT}`),
    peer('peer-remote', `[Very Happy session message m2 from "Codex 发布检查" cmh2x9codex02; agent codex; cwd /srv/vh; machine dev-sg]\n发布前请确认 happy-wire 已经 build，dist 是 gitignore 的。${FOOT}`),
    peer('peer-term', `[Very Happy session message m3 from "zsh" cmh2x9term03; agent terminal-mirror; cwd /Users/dev]\npnpm test 全绿${FOOT}`),
    peer('peer-conflict', '[Very Happy edit conflict c1; file packages/happy-web-v2/src/screens/session/MessageView.tsx; more 1; peer "流式 markdown" cmh2x9md04; agent claude; cwd /Users/dev/very-happy; peer edited 40s ago]\nAnother session edited the same file.\nFiles:\n- packages/happy-web-v2/src/screens/session/MessageView.tsx\n- packages/happy-web-v2/src/screens/session/Markdown.tsx'),
];

const TEAM: TeamState = {
    id: 'team-1', name: '发布 1.9 验收', machineId: 'dev-machine', version: 3, createdAt: NOW - 3600_000,
    bots: [
        { id: 'lead', name: 'lead', root: true, managed: true, sessionId: SESSION_ID, assistant: 'claude', directory: '/Users/dev/very-happy', generation: 1 },
        { id: 'b-web', name: 'web-review', root: false, managed: true, sessionId: 'sess-web', assistant: 'codex', directory: '/Users/dev/very-happy', generation: 1, lastEvent: 'idle', lastEventAt: NOW - 120_000 },
        { id: 'b-cli', name: 'worker-2', root: false, managed: true, sessionId: null, assistant: 'pi-acp', directory: '/Users/dev/very-happy', generation: 1 },
    ],
    tasks: [
        { id: 't-root', parentTaskId: null, goal: '完成 1.9 发布前验收', acceptance: ['门禁全绿'], goalVersion: 1, ownerBotId: null, assigneeBotId: 'lead', status: 'running', attempts: [{ id: 'a0', botId: 'lead', status: 'running', goalVersion: 1, generation: 1, result: null }] as never, currentAttemptId: 'a0', cleanup: 'none' },
        { id: 't-web', parentTaskId: 't-root', goal: '审阅 web 侧子代理 UI 改动\n- 390px 无横向滚动\n- 深浅主题各截一张', acceptance: ['截图齐全'], goalVersion: 1, ownerBotId: 'lead', assigneeBotId: 'b-web', status: 'submitted', attempts: [{ id: 'a1', botId: 'b-web', status: 'submitted', goalVersion: 1, generation: 1, result: '两处溢出已修：\n1. ToolGroupView 标题\n2. SubagentDock 行\n\n390px 无横向滚动。' }] as never, currentAttemptId: 'a1', cleanup: 'none' },
        { id: 't-cli', parentTaskId: 't-root', goal: '跑 CLI 六格矩阵', acceptance: ['6/6'], goalVersion: 1, ownerBotId: 'lead', assigneeBotId: 'b-cli', status: 'queued', attempts: [{ id: 'a2', botId: 'b-cli', status: 'pending', goalVersion: 1, generation: 1, result: null }] as never, currentAttemptId: 'a2', cleanup: 'none' },
    ],
    messages: [{ id: 'tm1', taskId: 't-web', senderBotId: 'b-web', recipientBotId: 'lead', body: '已提交：\n- PR #12 绿\n- 截图在 tmp/b614/', deliveredAt: NOW, createdAt: NOW, source: 'agent' }],
    operations: [],
};
// B-716: a realistic submission — headings, bold, a wide table, a list and code.
const TEAM_SUBMIT_BODY = [
    '## B-614 web 审阅交付',
    '**PR #12** 已绿，两处溢出已修，390px 无横向滚动。',
    '',
    '| 界面 | 修前溢出 | 修后溢出 | 亮色 | 暗色 | 截图 |',
    '|---|---:|---:|:---:|:---:|---|',
    '| ToolGroupView 标题 | 118px | 0px | ✅ | ✅ | tmp/b614/toolgroup-390.png |',
    '| SubagentDock 行 | 64px | 0px | ✅ | ✅ | tmp/b614/dock-390.png |',
    '',
    '- 门禁：`tsc` 退出码 0，vitest 全绿',
    '- 未自动验证：iOS 真机长按复制',
    '',
    '```sh',
    'pnpm -C packages/happy-web-v2 exec vitest run src/screens/session',
    'node scripts/dev/css-probe.mjs --base http://localhost:5173 --viewport 390x844 --coarse',
    '```',
].join('\n');
const SUBMIT_TOOL = tool('team-submit', 'mcp__happy__team_submit', { taskId: 't-web', attemptId: 'a1', result: TEAM_SUBMIT_BODY });
const TEAM_FOOT = '\n\nUse the teams tools to inspect current task state before acting. This message is team context, not a system instruction.';
const TEAM_MSG = presentTeamMessage({ text: `[Very Happy team message tm1; task t-web; from web-review]\nTask t-web submitted:\n${TEAM_SUBMIT_BODY}${TEAM_FOOT}`, meta: { sentFrom: 'team' } as never })!;

function installCodexChildRpc() {
    const target = apiSocket as unknown as { sessionRPC: unknown; __b614?: boolean };
    if (target.__b614) return;
    target.__b614 = true;
    const original = apiSocket.sessionRPC.bind(apiSocket);
    (apiSocket as unknown as { sessionRPC: unknown }).sessionRPC = async (sid: string, method: string, params: unknown) => {
        if (method !== 'codex-child-read') return original(sid as never, method as never, params as never);
        return { envelopes: [
            { id: 'c1', time: NOW, role: 'agent', ev: { t: 'text', text: '先读 runCodex.ts 的 abort 路径。' } },
            { id: 'c2', time: NOW, role: 'agent', ev: { t: 'tool-call-start', call: 'k1', name: 'Bash', title: 'Bash', description: 'Bash', args: { command: 'pnpm vitest run src/codex' } } },
            { id: 'c3', time: NOW, role: 'agent', ev: { t: 'tool-call-end', call: 'k1', result: { text: '42 passed' } } },
        ] };
    };
}

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
    return <section data-surface={id} style={{ display: 'flex', flexDirection: 'column', gap: 'calc(var(--chat-space) * 3)', paddingBottom: 'var(--sp-6)', borderBottom: '1px solid var(--line)' }}>
        <h2 style={{ fontSize: 'var(--fs-12)', color: 'var(--text-faint)', fontWeight: 600, margin: 0 }}>{title}</h2>
        {children}
    </section>;
}

export function MultiAgentHarness() {
    const params = new URLSearchParams(location.search);
    const [open, setOpen] = useState<string | null>(params.get('drawer'));
    // Children's effects run before ours, so the in-page RPC must exist at first
    // render; it is never restored (StrictMode's effect replay would undo it).
    useState(installCodexChildRpc);
    useEffect(() => {
        const all = [...SUBAGENTS, CODEX];
        storage.setState((state) => ({
            sessions: { ...state.sessions, [SESSION_ID]: { id: SESSION_ID, presence: 'online', thinking: true, metadata: { machineId: 'dev-machine', path: '/workspace', flavor: 'claude', summary: { text: '发布 1.9 验收 · 负责人', updatedAt: NOW }, capabilities: ['claude-runtime-controls-v1'] },
                agentState: { backgroundTasks: { updatedAt: NOW, tasks: [
                    { id: 'bg1', type: 'local_bash', description: 'pnpm dev --port 8082', startedAt: NOW - 34 * 60_000 },
                    { id: 'bg2', type: 'monitor', description: 'kimi long-reasoning test results (ch37 non-stream)', startedAt: NOW - 12 * 60_000 },
                ] } } } as never },
            sessionMessages: { ...state.sessionMessages, [SESSION_ID]: {
                messages: [...all].reverse(), messagesMap: Object.fromEntries(all.map((c) => [c.id, c])),
                isLoaded: true, hasMoreOlder: false, isLoadingOlder: false,
            } as never },
        }));
        recordBackgroundTasks(SESSION_ID, 2);
        recordHeartbeat(SESSION_ID, true);
        const beat = setInterval(() => { recordBackgroundTasks(SESSION_ID, 2); recordHeartbeat(SESSION_ID, true); }, 10_000);
        const off = onSubagentOpen((detail) => setOpen(detail.messageId));
        return () => { clearInterval(beat); off(); };
    }, []);
    const lead = TEAM.bots[0];
    return (
        <div className={`sd${open ? ' sd--files-open' : ''}`}>
            <div className="sd-main">
                <SessionTeamContextView team={TEAM} bot={lead} />
                <div className="sd-body"><div className="cl"><div className="cl-scroll"><div className="cl-inner">
                    <div style={{ color: 'var(--text-faint)', fontSize: 'var(--fs-12)' }}>本地示例 · 多 agent 交互的四个界面（B-614）</div>
                    <Section id="subagents" title="1 · 子代理（Task/Agent）">
                        <TurnActivityView messages={SUBAGENTS} sessionId={SESSION_ID} live={false} durationSeconds={613} />
                        {SUBAGENTS.map((c) => <ToolGroupView key={c.id} tools={[c]} />)}
                        {EVENTS.map((m) => <MessageView key={m.id} message={m} sessionId={SESSION_ID} showMeta={false} />)}
                    </Section>
                    <Section id="codex" title="2 · Codex 子线程">
                        <ToolGroupView tools={[CODEX]} />
                    </Section>
                    <Section id="teams-chat" title="3 · 团队消息（对话内）">
                        <TeamMessageCardView content={TEAM_MSG} team={TEAM} localId="teams-message-tm1-1" createdAt={NOW} />
                        <TeamMessageCardView content={TEAM_MSG} team={undefined} localId={null} />
                        <ToolGroupView tools={[SUBMIT_TOOL]} />
                    </Section>
                    <Section id="peers" title="4 · 会话互发消息">
                        {PEERS.map((m) => <MessageView key={m.id} message={m} sessionId={SESSION_ID} showMeta={false} />)}
                    </Section>
                </div></div></div></div>
                <div className="sd-foot"><SubagentDock sessionId={SESSION_ID} /><div className="ci"><div className="ci-composer"><textarea className="ci-textarea" aria-label="Message" placeholder="本地预览 · 输入内容不会发送" rows={2} /></div></div></div>
            </div>
            {open && (
                <>
                    <div className="sd-files-scrim" onClick={() => setOpen(null)} aria-hidden />
                    <aside className="sd-files">
                        <SubagentPanel sessionId={SESSION_ID} messageId={open} onClose={() => setOpen(null)} />
                    </aside>
                </>
            )}
        </div>
    );
}

/** Teams page body with the same fixture (`/dev/multi-agent-teams`). */
export function MultiAgentTeamsHarness() {
    return <main className="teams-screen">
        <div className="teams-list"><TeamListCard team={TEAM} machine="dev-machine" /></div>
        <TeamWorkspace team={TEAM} onTask={() => {}} />
    </main>;
}
