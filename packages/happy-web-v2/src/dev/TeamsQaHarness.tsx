/** DEV-only visual harness for B-723 (QA2 follow-ups): the /teams list card
 *  with many inactive members (D1), the 「需要处理」 list with closed-before-
 *  spawn / unknown-outcome / retained-cleanup operations before and after the
 *  machine metadata arrives (O2, O3), and a feature tip next to an offline
 *  banner (O4). Route `/dev/teams-qa` (stripped from prod builds); all data is
 *  local, nothing is sent. `?case=rawmd` (B-746): task previews whose goals and
 *  results carry markdown and the team protocol header. `?case=finished`
 *  (B-753): a team with 35 finished tasks (done / cancelled) next to live work. */
import { useEffect, useRef } from 'react';
import type { TeamBot, TeamOperation, TeamState } from '@slopus/happy-wire';
import { TeamListCard, TeamWorkspace } from '@/screens/teams/TeamWorkspace';
import { OperationResolution } from '@/screens/teams/TeamsScreen';
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
