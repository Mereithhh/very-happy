/** DEV-only visual harness for B-723 (QA2 follow-ups): the /teams list card
 *  with many inactive members (D1), the 「需要处理」 list with closed-before-
 *  spawn / unknown-outcome / retained-cleanup operations before and after the
 *  machine metadata arrives (O2, O3), and a feature tip next to an offline
 *  banner (O4). Route `/dev/teams-qa` (stripped from prod builds); all data is
 *  local, nothing is sent. */
import { useEffect, useRef } from 'react';
import type { TeamBot, TeamOperation, TeamState } from '@slopus/happy-wire';
import { TeamListCard } from '@/screens/teams/TeamWorkspace';
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
