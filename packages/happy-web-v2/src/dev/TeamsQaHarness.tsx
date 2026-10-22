/** DEV-only visual harness for B-723 (QA2 follow-ups): the /teams list card
 *  with many inactive members (D1), the 「需要处理」 list with closed-before-
 *  spawn / unknown-outcome / retained-cleanup operations before and after the
 *  machine metadata arrives (O2, O3), and a feature tip next to an offline
 *  banner (O4). Route `/dev/teams-qa` (stripped from prod builds); all data is
 *  local, nothing is sent. `?case=rawmd` (B-746): task previews whose goals and
 *  results carry markdown and the team protocol header. `?case=finished`
 *  (B-753): a team with 35 finished tasks (done / cancelled) next to live work.
 *  `?case=states` (B-761): the Owner's teams as read from production on
 *  10-22 09:58Z (every lead / member execution as it actually was), then one
 *  task per derived state with its details head.
 *  `?case=solo` (B-759): a team with only its lead — 「成员由负责人按需创建」 and the ⓘ.
 *  `?case=start` (B-759): the 新建团队 dialog with its 「按需创建成员」 note (nothing is sent). */
import { useEffect, useRef } from 'react';
import type { TeamBot, TeamOperation, TeamState } from '@slopus/happy-wire';
import { TeamListCard, TeamWorkspace } from '@/screens/teams/TeamWorkspace';
import { TeamDialog } from '@/screens/teams/TeamDialog';
import { TeamStartForm } from '@/screens/teams/TeamStartForm';
import { OperationResolution } from '@/screens/teams/TeamsScreen';
import { TeamTaskSummary } from '@/screens/teams/TeamTaskDetail';
import type { AgentExecution } from '@/sync/agentStatus';
import { attentionOperations, teamRetrySupport } from '@/screens/teams/teamView';
import { FeatureTipHost, resetFeatureTips, useFeatureTipAnchor } from '@/components/featureTips/FeatureTips';
import '@/screens/teams/teams.css';
import '@/screens/session/mirror.css';

const NOW = Date.now();
const bot = (id: string, extra: Partial<TeamBot> = {}): TeamBot => ({ id, name: id, root: false, managed: true, sessionId: null, assistant: 'claude', directory: `/home/dev/.happy/teams/worktrees/${id}`, generation: 1, ...extra });
const op = (id: string, extra: Partial<TeamOperation>): TeamOperation => ({ id, teamId: 'team-qa', machineId: 'dev-machine', taskId: 't-done', botId: 'w1', attemptId: 'a1', generation: 1, type: 'spawn', status: 'failed', claimId: `claim-${id}`, claimedAt: NOW, error: null, sessionId: null, directory: '/home/dev/very-happy', assistant: 'claude', prompt: '', createdAt: NOW, ...extra });

export const QA_TEAM: TeamState = {
  id: 'team-qa', name: 'VeryHappy 研发', machineId: 'dev-machine', version: 1, createdAt: NOW - 86_400_000,
  creationLaunch: { goal: '研发团队', assistant: 'claude', directory: '/home/dev/very-happy' } as TeamState['creationLaunch'],
  bots: [
    bot('lead', { name: 'Lead', root: true, sessionId: 's-lead', lastEvent: 'idle', lastEventAt: NOW }),
    bot('dev-a', { name: 'Dev-A', sessionId: 's-a', lastEvent: 'idle', lastEventAt: NOW }),
    bot('dev-b', { name: 'Dev-B', sessionId: 's-b', lastEvent: 'idle', lastEventAt: NOW }),
    ...Array.from({ length: 20 }, (_, i) => bot(`old-${i}`, { name: `Old-${i}`, lastEvent: 'exited', lastEventAt: NOW - 3_600_000 })),
  ],
  tasks: [
    { id: 't-a', parentTaskId: null, goal: '修 D1', acceptance: [], goalVersion: 1, ownerBotId: 'lead', assigneeBotId: 'dev-a', status: 'running', attempts: [{ id: 'aa', botId: 'dev-a', status: 'running', goalVersion: 1, generation: 1, result: null }] as never, currentAttemptId: 'aa', cleanup: 'none' },
    { id: 't-done', parentTaskId: null, goal: '旧任务', acceptance: [], goalVersion: 1, ownerBotId: 'lead', assigneeBotId: 'old-0', status: 'done', attempts: [{ id: 'a1', botId: 'old-0', status: 'accepted', goalVersion: 1, generation: 1, result: 'ok' }] as never, currentAttemptId: 'a1', cleanup: 'failed' },
  ],
  messages: [],
  operations: [
    op('closed-1', { error: 'task_closed_before_spawn', claimId: null }),
    op('closed-2', { error: 'task_closed_before_spawn', claimId: null }),
    op('closed-3', { error: 'task_closed_before_spawn', claimId: null }),
    op('unknown-1', { status: 'unknown', error: 'Spawn outcome unknown; reconcile the worker before retrying' }),
    op('stop-1', { type: 'stop', error: 'Unmerged work retained on codex/team-1 at /home/dev/.happy/teams/worktrees/1: 2 commits are not pushed or merged; push or merge, then retry cleanup' }),
  ],
};

const RAW_GOAL = '[Very Happy team message m-qa; task t-run; from Lead]\nTask 47280515-0e1a-42c8-b8b2-984a6d38af4d\n**[QA] QA3 卡片测试任务**：在 `README.md` 末尾加一行\n\n| 步骤 | 说明 |\n|---|---|\n| 1 | 改 README |\n\n```sh\npnpm test\n```';
export const RAW_MD_TEAM: TeamState = {
  ...QA_TEAM, id: 'team-md', name: '[QA] QA3 团队', operations: [],
  bots: QA_TEAM.bots.slice(0, 3),
  tasks: [
    { ...QA_TEAM.tasks[0], id: 't-run', goal: RAW_GOAL, assigneeBotId: 'dev-a' },
    { ...QA_TEAM.tasks[0], id: 't-sub', goal: '## [QA] 验收用测试团队\n- 只在 **README.md** 加一行\n- 不改代码', assigneeBotId: 'dev-b', status: 'submitted', attempts: [{ id: 'aa', botId: 'dev-b', status: 'submitted', goalVersion: 1, generation: 1, result: '## 结果\n- **已完成**：`README.md` +1 行\n\n| 门禁 | 结果 |\n|---|---|\n| vitest | ✅ |' }] as never },
  ],
};

const FINISHED_COUNT = 35;
export const FINISHED_TEAM: TeamState = {
  ...QA_TEAM, id: 'team-finished', name: '[QA] 已结束很多的团队',
  bots: QA_TEAM.bots.slice(0, 3),
  tasks: [
    QA_TEAM.tasks[0],
    { ...QA_TEAM.tasks[0], id: 't-review', goal: '待验收的任务', assigneeBotId: 'dev-b', status: 'submitted', attempts: [{ id: 'aa', botId: 'dev-b', status: 'submitted', goalVersion: 1, generation: 1, result: '已提交证据' }] as never },
    ...Array.from({ length: FINISHED_COUNT }, (_, i) => ({ ...QA_TEAM.tasks[1], id: `t-fin-${i + 1}`, goal: `已结束任务 #${i + 1}`, assigneeBotId: i % 2 ? 'dev-a' : 'dev-b', status: i % 7 === 3 ? 'cancelled' as const : 'done' as const, cleanup: 'done' as const })),
  ],
  // Finish order: each task's stop operation — #1 oldest, #35 newest.
  operations: Array.from({ length: FINISHED_COUNT }, (_, i) => op(`stop-fin-${i + 1}`, { type: 'stop', status: 'completed', taskId: `t-fin-${i + 1}`, createdAt: NOW - (FINISHED_COUNT - i) * 60_000 })),
};

// B-761: production shapes (status / binding / lastEvent) and what each member session was doing.
const runTask = (id: string, assigneeBotId: string, goal: string, extra: Partial<TeamState['tasks'][number]> = {}): TeamState['tasks'][number] =>
  ({ id, parentTaskId: 'root-vh', goal, acceptance: ['验收标准'], goalVersion: 1, ownerBotId: 'lead', assigneeBotId, status: 'running', attempts: [{ id: `a-${id}`, botId: assigneeBotId, status: 'running', goalVersion: 1, generation: 1, result: null }], currentAttemptId: `a-${id}`, cleanup: 'none', ...extra });
export const PROD_VH_TEAM: TeamState = {
  ...QA_TEAM, id: 'team-vh', name: 'VeryHappy 研发', operations: [],
  bots: [
    bot('lead', { name: 'Lead', root: true, sessionId: 's-lead', lastEvent: 'idle', lastEventAt: NOW - 3 * 60_000 }),
    bot('dev-e1', { name: 'Dev-E1', sessionId: 's-e1', lastEvent: 'idle', lastEventAt: NOW - 30 * 60_000 }),
    bot('dev-k2', { name: 'Dev-K2', sessionId: 's-k2', generation: 3, lastEvent: 'idle', lastEventAt: NOW - 14 * 3_600_000 }),
    bot('release2', { name: 'Release2', sessionId: 's-r2', lastEvent: 'idle', lastEventAt: NOW - 8 * 3_600_000 }),
    bot('ui-audit', { name: 'UI-Audit', sessionId: 's-ui' }),
  ],
  tasks: [
    runTask('root-vh', 'lead', '这是 veryhappy 项目的专属团队，目标是尽量并行、快速的完成各种相关需求。', { parentTaskId: null, ownerBotId: null }),
    runTask('e21ceb87', 'dev-e1', '你是 B-759 的研发（复用 Dev-E1）'),
    runTask('47d883d3', 'dev-k2', '你是 B-761 的研发（复用 Dev-K2）'),
    runTask('f9580aba', 'release2', '你是第四版的发版负责人（复用 Release2）'),
    runTask('87ca10bf', 'ui-audit', '你负责 B-760 的设计（复用 UI-Audit）'),
  ],
};
export const PROD_BIZ_TEAM: TeamState = {
  ...QA_TEAM, id: 'team-biz', name: '业务数据治理', operations: [],
  bots: [bot('lead-biz', { name: 'Lead', root: true, sessionId: 's-biz', lastEvent: 'idle', lastEventAt: NOW - 133 * 60_000 }), bot('rank', { name: '实验排名' })],
  tasks: [
    runTask('root-biz', 'lead-biz', '业务数据治理：把公司的业务数据接到一起、核准，用来回答「资源花得值不值」。', { parentTaskId: null, ownerBotId: null }),
    { ...runTask('ac3a68a7', 'rank', 'W41 排名发布'), status: 'done', cleanup: 'done' },
  ],
};
const PROD_EXECUTION: Record<string, AgentExecution> = { 's-lead': 'idle', 's-e1': 'running', 's-k2': 'running', 's-r2': 'running', 's-ui': 'running', 's-biz': 'idle' };
// One task per derived state (B-761 teamTaskState table).
export const STATES_TEAM: TeamState = {
  ...QA_TEAM, id: 'team-states', name: '[QA] 任务状态', messages: [],
  bots: [
    bot('lead', { name: 'Lead', root: true, sessionId: 's-lead' }),
    ...['working', 'waiting', 'idle', 'stopped', 'checking', 'starting', 'failed', 'queued'].map(k => bot(`m-${k}`, { name: k, sessionId: ['starting', 'failed', 'queued'].includes(k) ? null : `s-${k}` })),
  ],
  tasks: [
    runTask('t-working', 'm-working', '成员正在跑一轮'),
    runTask('t-waiting', 'm-waiting', '成员在等权限确认'),
    runTask('t-idle', 'm-idle', '成员这一轮结束了但没提交'),
    runTask('t-stopped', 'm-stopped', '成员会话已退出、任务没收尾'),
    runTask('t-checking', 'm-checking', '成员会话状态还没到'),
    runTask('t-starting', 'm-starting', '正在启动成员', { status: 'queued' }),
    runTask('t-failed', 'm-failed', '成员启动失败', { status: 'queued' }),
    runTask('t-queued', 'm-queued', '等成员名额', { status: 'queued' }),
    { ...runTask('t-submitted', 'm-working', '已提交待验收'), status: 'submitted', attempts: [{ id: 'a-t-submitted', botId: 'm-working', status: 'submitted', goalVersion: 1, generation: 1, result: '证据' }] as never },
  ],
  operations: [
    op('spawn-starting', { taskId: 't-starting', botId: 'm-starting', attemptId: 'a-t-starting', status: 'claimed' }),
    op('spawn-failed', { taskId: 't-failed', botId: 'm-failed', attemptId: 'a-t-failed', status: 'failed', error: 'Team repository is missing: /home/dev/very-happy' }),
  ],
};
const STATES_EXECUTION: Record<string, AgentExecution> = { 's-lead': 'running', 's-working': 'running', 's-waiting': 'input', 's-idle': 'idle', 's-stopped': 'offline' };
const reader = (map: Record<string, AgentExecution>) => (sessionId: string) => map[sessionId];
export const SOLO_TEAM: TeamState = { ...QA_TEAM, id: 'team-solo', name: '[QA] 只有负责人的团队', bots: QA_TEAM.bots.slice(0, 1), tasks: [], operations: [] };

function TipAnchor() {
  const ref = useRef<HTMLButtonElement | null>(null);
  useFeatureTipAnchor('quick-open', ref, true, { dismissOnClick: false });
  return <button ref={ref} type="button" style={{ position: 'absolute', right: 16, top: 12 }}>📄</button>;
}

export function TeamsQaHarness() {
  const view = new URLSearchParams(location.search).get('case') ?? 'teams';
  useEffect(() => { if (view === 'tip') resetFeatureTips(); }, [view]);
  if (view === 'tip') return <main style={{ position: 'relative', minHeight: '100vh', background: 'var(--bg-0)' }}>
    <header style={{ height: 48, borderBottom: '1px solid var(--line)' }}><TipAnchor /></header>
    <div className="mrb"><div className="mrb-note" role="status"><span className="mrb-note-text">此会话已离线。恢复后可以在这里继续对话。</span><button type="button" className="mrb-term-btn mono"><span>恢复</span></button></div></div>
    <FeatureTipHost />
  </main>;
  if (view === 'rawmd') return <main className="teams-screen">
    <div className="teams-list"><TeamListCard team={RAW_MD_TEAM} machine="dev-sg" now={NOW} /></div>
    <TeamWorkspace team={RAW_MD_TEAM} onTask={() => {}} now={NOW} />
  </main>;
  if (view === 'states') return <main className="teams-screen">
    <div className="teams-list">
      <TeamListCard team={PROD_VH_TEAM} machine="dev-sg" now={NOW} execution={reader(PROD_EXECUTION)} />
      <TeamListCard team={PROD_BIZ_TEAM} machine="dev-sg" now={NOW} execution={reader(PROD_EXECUTION)} />
    </div>
    <div data-case="prod-biz"><TeamWorkspace team={PROD_BIZ_TEAM} onTask={() => {}} now={NOW} execution={reader(PROD_EXECUTION)} /></div>
    <div data-case="prod-vh"><TeamWorkspace team={PROD_VH_TEAM} onTask={() => {}} now={NOW} execution={reader(PROD_EXECUTION)} /></div>
    <div data-case="all-states"><TeamWorkspace team={STATES_TEAM} onTask={() => {}} now={NOW} execution={reader(STATES_EXECUTION)} /></div>
    <section data-case="details">{['t-idle', 't-stopped', 't-waiting'].map(id => <article key={id} className="teams-task"><TeamTaskSummary team={STATES_TEAM} task={STATES_TEAM.tasks.find(t => t.id === id)!} execution={reader(STATES_EXECUTION)} /></article>)}</section>
  </main>;
  if (view === 'start') return <main className="teams-screen">
    <TeamDialog title="新建团队" onClose={() => {}}><TeamStartForm intentScope="dev-qa" onStart={() => new Promise(() => {})} onStarted={() => {}} /></TeamDialog>
  </main>;
  if (view === 'solo') return <main className="teams-screen">
    <TeamWorkspace team={SOLO_TEAM} onTask={() => {}} now={NOW} />
  </main>;
  if (view === 'finished') return <main className="teams-screen">
    <TeamWorkspace team={FINISHED_TEAM} onTask={() => {}} now={NOW} />
  </main>;
  const attention = attentionOperations(QA_TEAM);
  // `loading`: the execution machine is known but its metadata has not arrived (O3).
  const machine = { metadata: view === 'loading' ? null : { teamRetryVersion: 2 } };
  return <main className="teams-screen">
    <div className="teams-list"><TeamListCard team={QA_TEAM} machine="dev-sg" now={NOW} /></div>
    <section data-case={view}>
      {attention.open.length > 0 && <h2>执行需要处理</h2>}
      {attention.open.map(operation => <OperationResolution key={operation.id} team={QA_TEAM} operation={operation}
        retrySupported={teamRetrySupport(machine)} cleanupRetrySupported={teamRetrySupport(machine, 2)} disabled={false} act={async () => {}} />)}
    </section>
  </main>;
}
