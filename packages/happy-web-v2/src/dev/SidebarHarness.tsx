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
import { recordHeartbeat } from '@/sync/heartbeatLease';
import { useTerminalAgentStates } from '@/sync/terminalAgentState';
import { Sidebar } from '@/screens/sessions/Sidebar';
import { CommandPalette } from '@/screens/command/CommandPalette';
import type { Session, Machine } from '@/sync/storageTypes';

// console access for the driving harness (same names the old spine used)
if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).vhStorage = storage;
  (window as unknown as Record<string, unknown>).vhSync = sync;
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
    // 等我看 (reap band: idle, most recent first)
    fakeSession('s4', 'Delta idle', 4, { tags: ['web'], flavor:'pi' }),
    fakeSession('s5', 'Echo idle older', 5),
    // 已完成(今日) — collapsed section, newest first: s6 above s7
    fakeSession('s6', 'Foxtrot done 2h ago', 6, { completedAgoMs: 2 * 3600_000 }),
    fakeSession('s7', 'Golf done 5h ago', 7, { completedAgoMs: 5 * 3600_000 }),
    // archived view only (never in 已完成 — no completedAt)
    fakeSession('s8', 'Hotel archived', 8, { archived: true }),
  ]);
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
    ],
  });
  useTerminalAgentStates.getState().ingest('m1', [
    { id:'term1', agentKind:'claude', agentState:'working', agentObservedAt:now },
    { id:'term2', agentKind:'pi', agentState:'needs_input', agentObservedAt:now },
    { id:'term3' },
    { id:'term4', agentKind:'codex', agentState:'idle', agentObservedAt:now },
    { id:'term5', agentKind:'pi', agentState:'working', agentObservedAt:now },
  ]);
  for (const id of ['s1','s2','s3','s4','s5']) recordHeartbeat(id, id === 's3', now);

}

export function SidebarHarness() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    seed();
    setReady(true);
    const timer = setInterval(() => {
      for (const id of ['s1','s2','s3','s4','s5']) recordHeartbeat(id, id === 's3');
      const states = useTerminalAgentStates.getState().states;
      useTerminalAgentStates.getState().ingest('m1', Object.entries(states).map(([id, e]) => ({ id, agentKind:e.agentKind, agentState:e.state, agentObservedAt:Date.now() })));
    }, 2000);
    return () => clearInterval(timer);
  }, []);
  if (!ready) return null;
  return (
    <div style={{ display: 'flex', height: '100dvh', background: 'var(--bg-0)' }}>
      <style>{'@media(max-width:600px){.sidebar-harness-note{display:none}}'}</style>
      <div
        style={{
          width: 320,
          maxWidth: '100vw',
          display: 'flex',
          flexDirection: 'column',
          borderRight: '1px solid var(--line)',
          background: 'var(--bg-1)',
        }}
      >
        <Sidebar />
      </div>
      <main className="sidebar-harness-note" style={{ flex: 1, padding:24 }}>本地状态预览 · 示例数据<br/>灰色类型图标；右侧统一状态位。终端区分 Claude、Codex、Pi。</main>
      {/* the sidebar's search entry (⌘K / mobile header icon) — real palette */}
      <CommandPalette />
    </div>
  );
}
