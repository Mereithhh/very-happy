/**
 * B-762: the B-760 prototype's 「Atlas」 scene as store data — four projects
 * (one with a team and two sessions, one with a lead-only team, one plain,
 * one empty) plus 不在项目中 (an old team and loose chats). Shared by the
 * sidebar render tests and the `/dev/sidebar?scene=atlas` harness, so the
 * screenshots and the tests look at the same tree. Names are fictional.
 */
import type { ProjectMemberView, ProjectView, TeamOperation, TeamState } from '@slopus/happy-wire';
import type { Session } from '@/sync/storageTypes';

export type SceneKind = 'atlas' | 'solo' | 'fresh';

interface FakeOpts { thinking?: boolean; tags?: string[]; permission?: boolean; agoMin?: number }

function fakeSession(id: string, title: string, now: number, opts: FakeOpts = {}): Session {
  const ts = now - (opts.agoMin ?? 1) * 60_000;
  return {
    id, seq: 1, createdAt: ts, updatedAt: ts, active: true, activeAt: ts,
    metadata: { path: '/home/dev/atlas', flavor: 'claude', host: 'devbox', machineId: 'm1', summary: { text: title, updatedAt: ts }, ...(opts.tags ? { tags: opts.tags } : {}) } as unknown as Session['metadata'],
    metadataVersion: 1,
    agentState: opts.permission ? ({ requests: { r1: { tool: 'Bash', createdAt: now - 5 * 60_000 } } } as unknown as Session['agentState']) : null,
    agentStateVersion: 1,
    thinking: !!opts.thinking, thinkingAt: 0, presence: ts,
  };
}

function team(id: string, name: string, now: number, members: Array<{ id: string; name: string; sessionId: string | null; root?: boolean }>, retired: string[] = []): TeamState {
  const bot = (b: { id: string; name: string; sessionId: string | null; root?: boolean }) => ({ id: b.id, name: b.name, sessionId: b.sessionId, root: !!b.root, generation: 1, managed: true, assistant: 'claude', directory: null }) as TeamState['bots'][number];
  const spawn = (botId: string, sessionId: string, k: number): TeamOperation => ({ id: `op-${botId}`, teamId: id, machineId: 'm1', taskId: `task-${botId}`, botId, attemptId: `att-${botId}`, generation: 1, type: 'spawn', status: 'completed', claimId: 'c', claimedAt: now, error: null, sessionId, directory: '/home/dev/atlas', assistant: 'claude', prompt: 'goal', createdAt: now - k * 60_000 }) as TeamOperation;
  return {
    id, name, machineId: 'm1', version: 1, createdAt: now - 3600_000, tasks: [], messages: [],
    bots: [...members.map(bot), ...retired.map((n, k) => bot({ id: `${id}-r${k}`, name: n, sessionId: null }))],
    operations: retired.map((_, k) => spawn(`${id}-r${k}`, `${id}-old${k}`, k)),
  };
}

function project(id: string, name: string, now: number, teamIds: string[] = []): ProjectView {
  return { id, name, goal: null, instructions: '', instructionsVersion: 0, instructionsUpdatedBy: null, instructionsUpdatedAt: null, folders: [{ machineId: 'm1', path: `/home/dev/${id}`, primary: true }], defaults: {}, archivedAt: null, createdAt: now - 86_400_000, updatedAt: now - 3600_000, teamIds, automationIds: [] } as unknown as ProjectView;
}

export function sidebarTreeScene(kind: SceneKind, now = Date.now()): {
  sessions: Session[];
  teams: TeamState[];
  projects: ProjectView[];
  members: ProjectMemberView[];
  unread: string[];
} {
  if (kind === 'fresh') return { sessions: [], teams: [], projects: [], members: [], unread: [] };
  const loose = [
    fakeSession('regex', '正则写法速查', now, { agoMin: 2 }),
    fakeSession('shell', 'Shell 别名整理', now, { permission: true, tags: ['P1'], agoMin: 3 }),
    fakeSession('weekend', '写个周末计划', now, { agoMin: 40 }),
    fakeSession('paper', '论文阅读笔记', now, { tags: ['docs'], agoMin: 50 }),
  ];
  if (kind === 'solo') return { sessions: loose, teams: [], projects: [], members: [], unread: [] };
  const sessions = [
    fakeSession('lead', '拆分网关并分派', now, { thinking: true, agoMin: 1 }),
    fakeSession('fe1', '结算页改造', now, { thinking: true, agoMin: 2 }),
    fakeSession('be1', '退款接口迁移', now, { permission: true, agoMin: 3 }),
    fakeSession('qa1', '回归用例', now, { agoMin: 9 }),
    fakeSession('timeout', '排查退款回调超时', now, { tags: ['P0'], agoMin: 4 }),
    fakeSession('migrate', '迁移脚本草稿', now, { tags: ['api'], agoMin: 20 }),
    fakeSession('web-lead', '评估首页需求', now, { agoMin: 30 }),
    fakeSession('copy', '首页文案 A/B', now, { thinking: true, tags: ['web'], agoMin: 5 }),
    fakeSession('pricing', '定价页对比表', now, { tags: ['web'], agoMin: 60 }),
    fakeSession('metrics', '周报指标口径', now, { tags: ['docs'], agoMin: 90 }),
    // B-762 review: a long title in a long-named project — the list chip must not eat the title.
    fakeSession('ledger', '排查对账任务在月末批量重跑时的超时与重复入账', now, { agoMin: 120 }),
    fakeSession('scout-lead', '比较三家供应商', now, { agoMin: 6 }),
    fakeSession('scout-1', '整理报价', now, { agoMin: 70 }),
    ...loose,
  ];
  const teams = [
    team('t-atlas', 'Atlas 研发队', now, [
      { id: 'a-lead', name: 'Lead', sessionId: 'lead', root: true },
      { id: 'a-fe', name: '前端-1', sessionId: 'fe1' },
      { id: 'a-be', name: '后端-1', sessionId: 'be1' },
      { id: 'a-qa', name: '测试-1', sessionId: 'qa1' },
    ], ['前端-0', '运维-0']),
    team('t-web', '官网小队', now, [{ id: 'w-lead', name: 'Lead', sessionId: 'web-lead', root: true }]),
    team('t-scout', '临时调研队', now, [
      { id: 's-lead', name: 'Lead', sessionId: 'scout-lead', root: true },
      { id: 's-1', name: '调研-1', sessionId: 'scout-1' },
    ]),
  ];
  const projects = [
    project('pj-atlas', 'Atlas 支付重构', now, ['t-atlas']),
    project('pj-web', '官网改版', now, ['t-web']),
    project('pj-data', '数据看板', now),
    project('pj-mobile', '移动端试验', now),
    project('pj-ledger', '跨境结算与多币种对账平台迁移', now),
  ];
  const member = (projectId: string, sessionId: string): ProjectMemberView => ({ projectId, sessionId, via: 'explicit', machineId: null, createdAt: now }) as ProjectMemberView;
  const members = [member('pj-atlas', 'timeout'), member('pj-atlas', 'migrate'), member('pj-web', 'copy'), member('pj-web', 'pricing'), member('pj-data', 'metrics'), member('pj-ledger', 'ledger')];
  return { sessions, teams, projects, members, unread: ['timeout', 'scout-lead'] };
}
