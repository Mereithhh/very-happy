/**
 * B-892 prototype data. Owner-account SHAPE (projects with 10+ sessions each,
 * a team, 3 automation decisions), fictional names only. Nothing is fetched.
 */
import type { ProjectMemberView, ProjectView, TeamState } from '@slopus/happy-wire';
import { storage } from '@/sync/storage';
import type { Machine, Session } from '@/sync/storageTypes';
import { setProjectsDevOverride } from '@/sync/projects';
import { setTeamNavigationDevOverride } from '@/screens/sessions/useTeamNavigation';
import { useAutomations } from '@/sync/automationsStore';
import { recordHeartbeat } from '@/sync/heartbeatLease';
import { installIssuesHarness } from '@/dev/issuesHarness';
import type { FakeIssuesServer } from '@/sync/issuesFake';

export type SeedKind = 'owner' | 'active' | 'fresh';

const GROUPS: { id: string; name: string; titles: string[] }[] = [
  { id: 'pj-pay', name: '支付对账', titles: ['退款链路迁移', '上月流水核对', '对账日报模板', '账单导出分页', '风控规则回放', '结算延迟排查', '发票接口联调', '清算文件格式', '灰度开关梳理', '对账差异告警', '商户费率校验', '历史数据补录'] },
  { id: 'pj-kb', name: '知识库改版', titles: ['搜索排序调参', '文档权限模型', '编辑器粘贴图片', '目录拖拽排序', '首页信息架构', '段落引用锚点', '导入 Markdown', '移动端阅读页', '版本对比视图', '评论通知合并', '归档策略讨论'] },
  { id: 'pj-ops', name: '发布与运维', titles: ['蓝绿切换演练', '镜像体积优化', '日志字段脱敏', '告警阈值复盘', '数据库慢查询', 'CI 缓存命中率', '证书轮换脚本', '回滚手册更新', '健康检查收敛', '容量周报'] },
];

function fakeSession(id: string, title: string, agoMin: number, now: number, opts: { thinking?: boolean; permission?: boolean } = {}): Session {
  const ts = now - agoMin * 60_000;
  return {
    id, seq: 1, createdAt: ts, updatedAt: ts, active: true, activeAt: ts,
    metadata: { path: '/home/dev/workspace', flavor: 'claude', host: 'devbox', machineId: 'm1', summary: { text: title, updatedAt: ts } } as unknown as Session['metadata'],
    metadataVersion: 1,
    agentState: opts.permission ? ({ requests: { r1: { tool: 'Bash', createdAt: now - 5 * 60_000 } } } as unknown as Session['agentState']) : null,
    agentStateVersion: 1,
    thinking: !!opts.thinking, thinkingAt: 0, presence: ts,
  };
}

function project(id: string, name: string, now: number): ProjectView {
  return { id, name, goal: null, instructions: '', instructionsVersion: 0, instructionsUpdatedBy: null, instructionsUpdatedAt: null, folders: [{ machineId: 'm1', path: `/home/dev/${id}`, primary: true }], defaults: {}, archivedAt: null, createdAt: now - 86_400_000, updatedAt: now - 3_600_000, teamIds: [], automationIds: [] } as unknown as ProjectView;
}

function team(now: number): TeamState {
  return { id: 't1', name: '发布小队', machineId: 'm1', version: 1, createdAt: now - 3_600_000, tasks: [], messages: [], operations: [],
    bots: [{ id: 'lead', name: 'Lead', sessionId: null, root: true, generation: 1, managed: true, assistant: 'claude', directory: null }] } as unknown as TeamState;
}

const OWNER_DONE = ['接入旧待办：季度复盘材料', '接入旧待办：报销单', '接入旧待办：续费域名', '接入旧待办：整理会议纪要', '接入旧待办：更新团队手册', '接入旧待办：备份笔记', '接入旧待办：清理云账单', '接入旧待办：回复合作邮件', '接入旧待办：换证书', '接入旧待办：归档旧仓库'];

/** Applies a seed; returns a keep-alive for what the UI expires (heartbeats, automation badge). */
export function seedPrototype(kind: SeedKind): () => void {
  const now = Date.now();
  storage.getState().applyLocalSettings({ sidebarView: 'list', sidebarGrouping: 'project' });
  storage.getState().applyMachines([{
    id: 'm1', seq: 1, createdAt: now, updatedAt: now, active: true, activeAt: now,
    metadata: { host: 'devbox', platform: 'linux', displayName: 'devbox' }, metadataVersion: 1, daemonState: null, daemonStateVersion: 1,
  } as unknown as Machine]);

  const fresh = kind === 'fresh';
  const sessions: Session[] = [];
  const members: ProjectMemberView[] = [];
  if (!fresh) {
    let minute = 2;
    for (const group of GROUPS) {
      group.titles.forEach((title, i) => {
        const id = `${group.id}-${i}`;
        sessions.push(fakeSession(id, title, minute, now, { thinking: i === 2 || i === 5, permission: i === 7 && group.id === 'pj-pay' }));
        members.push({ projectId: group.id, sessionId: id, via: 'explicit', machineId: null, createdAt: now } as ProjectMemberView);
        minute += 7;
      });
    }
  }
  storage.getState().applySessions(sessions);
  setTeamNavigationDevOverride(fresh ? [] : [team(now)]);
  setProjectsDevOverride({ status: 'ready', projects: fresh ? [] : GROUPS.map((g) => project(g.id, g.name, now)), members });
  storage.getState().applyReady();

  const uninstallIssues = installIssuesHarness(kind === 'active' ? '#issues' : '#issues-empty', 'm1');
  const server = (window as unknown as { __vhIssues: FakeIssuesServer }).__vhIssues;
  if (kind === 'owner') {
    void (async () => {
      for (const title of OWNER_DONE) {
        const created = await server.transport('POST', '', { title, status: 'todo' });
        await server.transport('PATCH', `/${(created.data as { issue: { id: string } }).issue.id}`, { status: 'done' });
      }
    })();
  }

  const badge = () => useAutomations.setState({ enabled: true, attention: fresh ? [] : [{ id: 'r1' }, { id: 'r2' }, { id: 'r3' }] as never });
  const keepAlive = () => {
    badge();
    for (const s of sessions) recordHeartbeat(s.id, s.thinking);
  };
  keepAlive();
  const timer = setInterval(keepAlive, 2000);
  return () => { clearInterval(timer); uninstallIssues(); };
}
