/**
 * DEV-ONLY sidebar harness — route `/dev/sidebar`, mounted only when
 * `import.meta.env.DEV` (vite dev server; never in the production build).
 *
 * Seeds the real zustand stores (sessions + machines + web terminals + agent
 * states) with fake data and renders the REAL <Sidebar/> (plus the real
 * <CommandPalette/> — the sidebar's search entry) with no login and no
 * server, so pointer interactions (drag reorder, view switching, lifecycle
 * grouping, palette #tag search) can be driven by a real pointer
 * (chrome-devtools) against the exact code paths production uses.
 *
 * The seed covers every lifecycle bucket the status view groups by:
 *   waiting/permission (×2, different wait ages) · running (session thinking
 *   + terminal working) · waiting/idle (reap) · terminal needs_input ·
 *   completed-today (archived + completedAt) · plain archived.
 * Plus both row signals: 待处理 (accent, s1/s2/term2) and 未读 (red, s5).
 *
 * Settings writes still go through sync.applySettings → applySettingsLocal,
 * so the committed manual order is observable from the console:
 * `vhStorage.getState().settings.sidebarOrder`.
 * (The network push behind it fails without credentials — irrelevant here.)
 */
import { useEffect, useState } from 'react';
import { storage } from '@/sync/storage';
import { sync } from '@/sync/sync';
import { useTerminalSessions } from '@/sync/terminalSessions';
import { useAutomations } from '@/sync/automationsStore';
import { setProjectsDevOverride } from '@/sync/projects';
import { recordBackgroundTasks, recordHeartbeat } from '@/sync/heartbeatLease';
import { useTerminalAgentStates } from '@/sync/terminalAgentState';
import { Sidebar } from '@/screens/sessions/Sidebar';
import { ProjectsListScreen } from '@/screens/projects/ProjectsListScreen';
import { CommandPalette } from '@/screens/command/CommandPalette';
import { setTeamNavigationDevOverride } from '@/screens/sessions/useTeamNavigation';
import type { Session, Machine } from '@/sync/storageTypes';
import type { TeamOperation, TeamState } from '@slopus/happy-wire';

// console access for the driving harness (same names the old spine used)
if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).vhStorage = storage;
  (window as unknown as Record<string, unknown>).vhSync = sync;
  // B-641: drive the folded-entry attention badge (automation decisions)
  (window as unknown as Record<string, unknown>).vhAutomations = useAutomations;
}

interface FakeOpts {
  thinking?: boolean;
  flavor?: 'claude' | 'codex' | 'pi';
  /** minutes a pending permission request has been waiting */
  permissionWaitMin?: number;
  archived?: boolean;
  /** ms ago the session was marked done (implies archived) */
  completedAgoMs?: number;
  tags?: string[];
}

function fakeSession(id: string, title: string, i: number, opts: FakeOpts = {}): Session {
  const now = Date.now();
  const ts = now - i * 60_000;
  const active = !(opts.archived || opts.completedAgoMs != null);
  return {
    id,
    seq: i,
    createdAt: ts,
    updatedAt: ts,
    active,
    activeAt: ts,
    metadata: {
      path: '/home/dev/project',
      flavor: opts.flavor ?? 'claude',
      host: 'devbox',
      machineId: 'm1',
      summary: { text: title, updatedAt: now },
      ...(opts.tags ? { tags: opts.tags } : {}),
      ...(opts.completedAgoMs != null ? { completedAt: now - opts.completedAgoMs } : {}),
    } as unknown as Session['metadata'],
    metadataVersion: 1,
    agentState:
      opts.permissionWaitMin != null
        ? ({
            requests: {
              r1: { tool: 'Bash', createdAt: now - opts.permissionWaitMin * 60_000 },
            },
          } as unknown as Session['agentState'])
        : null,
    agentStateVersion: 1,
    thinking: !!opts.thinking,
    thinkingAt: 0,
    presence: ts, // recomputed by applySessions (active → 'online')
  };
}

const RETIRED_MEMBERS = ['Dev-A1', 'Dev-A2', 'Dev-B1', 'Dev-B2', 'Dev-C1', 'Dev-C2'];

/** B-674: a team with two live members (s3 lead, s4) and six retired ones. */
function harnessTeam(now: number): TeamState {
  const bot = (id: string, name: string, sessionId: string | null, root = false) => ({ id, name, sessionId, root, generation: 1, managed: true, assistant: 'claude', directory: null }) as TeamState['bots'][number];
  const spawn = (botId: string, sessionId: string, k: number): TeamOperation => ({ id: `op-${botId}`, teamId: 'team1', machineId: 'm1', taskId: `task-${botId}`, botId, attemptId: `att-${botId}`, generation: 1, type: 'spawn', status: 'completed', claimId: 'c', claimedAt: now, error: null, sessionId, directory: '/home/dev/project', assistant: 'claude', prompt: 'goal', createdAt: now - k * 60_000 }) as TeamOperation;
  return {
    id: 'team1', name: 'VeryHappy 研发', machineId: 'm1', version: 1, createdAt: now - 3600_000,
    bots: [bot('lead', 'Lead', 's3', true), bot('e1', 'Dev-E1', 's4'), ...RETIRED_MEMBERS.map((name, k) => bot(`r${k}`, name, null))],
    operations: RETIRED_MEMBERS.map((_, k) => spawn(`r${k}`, `s${30 + k}`, k)),
    tasks: [], messages: [],
  };
}

/** B-729: the production shape of 10-22 — roll-pool-cot's spawned Lead (sR)
 *  later created roll-pool and joined it as lead; roll-pool-cot reused its
 *  worker (sW1 → sW2). sR used to render outside both teams. */
function b729Teams(now: number): TeamState[] {
  const spawn = (teamId: string, botId: string, generation: number, sessionId: string): TeamOperation => ({ id: `op-${botId}-${generation}`, teamId, machineId: 'm1', taskId: `task-${botId}`, botId, attemptId: `att-${botId}-${generation}`, generation, type: 'spawn', status: 'completed', claimId: 'c', claimedAt: now, error: null, sessionId, directory: '/home/dev/pool', assistant: 'claude', prompt: 'goal', createdAt: now - (10 - generation) * 60_000 }) as TeamOperation;
  const bot = (id: string, name: string, sessionId: string | null, extra: Partial<TeamState['bots'][number]> = {}) => ({ id, name, sessionId, root: false, generation: 1, managed: true, assistant: 'claude', directory: null, ...extra }) as TeamState['bots'][number];
  return [
    { id: 'cot', name: 'roll-pool-cot', machineId: 'm1', version: 1, createdAt: now - 7200_000, tasks: [], messages: [],
      bots: [bot('cot-lead', 'Lead', 'sR', { root: true }), bot('cot-w', 'xhub-key-fetch', 'sW2', { generation: 2 })],
      operations: [spawn('cot', 'cot-lead', 1, 'sR'), spawn('cot', 'cot-w', 1, 'sW1'), spawn('cot', 'cot-w', 2, 'sW2')] },
    { id: 'pool', name: 'roll-pool', machineId: 'm1', version: 1, createdAt: now - 600_000, tasks: [], messages: [],
      bots: [bot('pool-root', 'roll-pool', 'sR', { root: true, managed: false }), bot('pool-a', 'or-gemini-eval', 'sP')],
      operations: [spawn('pool', 'pool-a', 1, 'sP')] },
  ];
}

function seed() {
  const now = Date.now();
  storage.getState().applyLocalSettings({
    terminalViewDefault: 'structured',
    terminalViewOverrides: {},
  });
  storage.getState().applyMachines([
    {
      id: 'm1',
      seq: 1,
      createdAt: now,
      updatedAt: now,
      active: true, // terminals on m1 are "machine online" for the board gate
      activeAt: now,
      metadata: { host: 'devbox', platform: 'linux' },
      metadataVersion: 1,
      daemonState: null,
      daemonStateVersion: 1,
    } as unknown as Machine,
  ]);
  storage.getState().applySessions([
    // status view — 等我看 (urgent band, longest wait first: s2 above s1)
    fakeSession('s1', 'Alpha perm 5m', 1, { permissionWaitMin: 5, tags: ['api', 'prod'] }),
    fakeSession('s2', 'Bravo perm 30m', 2, { permissionWaitMin: 30 }),
    // 进行中
    fakeSession('s3', 'Charlie building', 3, { thinking: true, flavor: 'codex' }),
    // B-507: turn ended, background tasks still running → 进行中 with the count
    fakeSession('s9', 'India background tasks', 3, {}),
    // 等我看 (reap band: idle, most recent first)
    fakeSession('s4', 'Delta idle', 4, { tags: ['web'], flavor:'pi' }),
    fakeSession('s5', 'Echo idle older', 5),
    // 已完成(今日) — collapsed section, newest first: s6 above s7
    fakeSession('s6', 'Foxtrot done 2h ago', 6, { completedAgoMs: 2 * 3600_000 }),
    fakeSession('s7', 'Golf done 5h ago', 7, { completedAgoMs: 5 * 3600_000 }),
    // archived view only (never in 已完成 — no completedAt)
    fakeSession('s8', 'Hotel archived', 8, { archived: true }),
    // B-641: a realistic backlog of idle chats, so the phone list overflows
    // and "rows visible on the first screen" is measurable.
    ...['Juliet', 'Kilo', 'Lima', 'Mike', 'November', 'Oscar', 'Papa', 'Quebec', 'Romeo', 'Sierra', 'Tango', 'Uniform']
      // B-675: a few first tags so 按标签 has real groups (and an untagged tail).
      .map((name, k) => fakeSession(`s${10 + k}`, `${name} idle chat`, 10 + k, k < 4 ? { tags: [['web', 'api', 'web', 'docs'][k]] } : {})),
    // B-674: retired team members — their sessions are archived.
    ...RETIRED_MEMBERS.map((name, k) => fakeSession(`s${30 + k}`, `${name} worker`, 30 + k, { archived: true })),
    fakeSession('sR', 'Coordinate coding agents via Very Happy teams', 0, { tags: ['teams'] }),
    fakeSession('sW1', 'xhub key fetch (gen 1)', 6),
    fakeSession('sW2', 'xhub key fetch (gen 2)', 2),
    fakeSession('sP', 'or-gemini-eval', 1),
  ]);
  setTeamNavigationDevOverride([harnessTeam(now), ...b729Teams(now)]);
  // projects API answered with no projects yet: every project-gated control shows.
  // B-756: `?projects=1` seeds two projects (one with a waiting session, one empty)
  // so the tag lens's 「项目」 area, the row chips and the project heads render.
  const withProjects = new URLSearchParams(window.location.search).get('projects') === '1';
  const harnessProject = (id: string, name: string, createdAt: number, folders: { machineId: string; path: string; primary: boolean }[]) => ({ id, name, goal: null, instructions: '', instructionsVersion: 0, instructionsUpdatedBy: null, instructionsUpdatedAt: null, folders, defaults: {}, archivedAt: null, createdAt, updatedAt: createdAt, teamIds: [], automationIds: [] });
  setProjectsDevOverride(withProjects
    ? {
      status: 'ready',
      projects: [harnessProject('pj-vh', 'very-happy', now - 2000, [{ machineId: 'm1', path: '/home/u/code/very-happy', primary: true }]), harnessProject('pj-docs', 'docs-site', now - 1000, [])],
      members: ['s1', 's4', 's10', 's12'].map((sessionId) => ({ projectId: 'pj-vh', sessionId, via: 'explicit', machineId: null, createdAt: now })),
    }
    : { status: 'ready', projects: [], members: [] });
  storage.getState().applyReady();
  // B-312 红色未读点：s5 跑完一轮而用户当时在看别处（真实产生路径在
  // applySessions 的 running→idle 检测里，harness 直接调同一个 action）
  storage.getState().markSessionUnread('s5');
  useTerminalSessions.setState({
    terminals: [
      {
        id: 'term1',
        machineId: 'm1',
        machineName: 'devbox',
        title: 'Claude mirror',
        mirrorSessionId: 'mirror-session-1',
        createdAt: now,
      },
      { id: 'term2', machineId: 'm1', machineName: 'devbox', title: 'agent needs input', createdAt: now - 60_000 },
      { id: 'term3', machineId: 'm1', machineName: 'devbox', title: '旧版终端 · 状态未知', createdAt: now - 120_000 },
      { id: 'term4', machineId: 'm1', machineName: 'devbox', title: 'Codex · 代码检查', createdAt: now - 180_000 },
      { id: 'term5', machineId: 'm1', machineName: 'devbox', title: 'Pi · 执行任务', createdAt: now - 240_000 },
      // B-486: direct shell on a machine without tmux
      { id: 'term6', machineId: 'm1', machineName: 'devbox', title: 'hyperpod', cwd: '/fsx/data', createdAt: now - 300_000, direct: true },
    ],
  });
  useTerminalAgentStates.getState().ingest('m1', [
    { id:'term1', agentKind:'claude', agentState:'working', agentObservedAt:now },
    { id:'term2', agentKind:'pi', agentState:'needs_input', agentObservedAt:now },
    { id:'term3' },
    { id:'term4', agentKind:'codex', agentState:'idle', agentObservedAt:now },
    { id:'term5', agentKind:'pi', agentState:'working', agentObservedAt:now },
  ]);
  recordBackgroundTasks('s9', 2);
  for (const id of ['s1','s2','s3','s4','s5','s9']) recordHeartbeat(id, id === 's3', now);

}

export function SidebarHarness() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    seed();
    setReady(true);
    const timer = setInterval(() => {
      for (const id of ['s1','s2','s3','s4','s5','s9']) recordHeartbeat(id, id === 's3');
      const states = useTerminalAgentStates.getState().states;
      useTerminalAgentStates.getState().ingest('m1', Object.entries(states).map(([id, e]) => ({ id, agentKind:e.agentKind, agentState:e.state, agentObservedAt:Date.now() })));
    }, 2000);
    return () => clearInterval(timer);
  }, []);
  if (!ready) return null;
  // B-756: `?page=projects` shows the /projects list beside the sidebar (phone: the list alone).
  const page = new URLSearchParams(window.location.search).get('page');
  return (
    <div style={{ display: 'flex', height: '100dvh', background: 'var(--bg-0)' }}>
      {/* phone: the real app renders the sidebar full-width (AppShell 'list' mode) */}
      <style>{'@media(max-width:600px){.sidebar-harness-note{display:none}.sidebar-harness-pane{width:100%!important;border-right:0!important}.sidebar-harness-pane.has-page{display:none!important}}'}</style>
      <div
        className={`sidebar-harness-pane${page ? ' has-page' : ''}`}
        style={{
          width: 320,
          maxWidth: '100vw',
          display: 'flex',
          flexDirection: 'column',
          borderRight: '1px solid var(--line)',
          // mirrors .app-sidebar (B-614: the sidebar is CDS surface-0, below the canvas)
          background: 'var(--surface-sidebar)',
        }}
      >
        <Sidebar />
      </div>
      {page === 'projects' ? <div style={{ flex: 1, minWidth: 0, display: 'flex' }}><ProjectsListScreen /></div> : <main className="sidebar-harness-note" style={{ flex: 1, padding:24 }}>本地状态预览 · 示例数据<br/>灰色类型图标；右侧统一状态位。终端区分 Claude、Codex、Pi。</main>}
      {/* the sidebar's search entry (⌘K / mobile header icon) — real palette */}
      <CommandPalette />
    </div>
  );
}
