/**
 * DEV-only harness for B-763 (位置感): the REAL session header, team page and
 * project page with their breadcrumbs, beside the real sidebar (team row menu
 * → 换项目…). Route `/dev/location-trail/:kind/:id` (kind = session | team |
 * project), stripped from prod builds. All data is local and fictional: the
 * stores get fixed sessions / teams / projects, and the team and project
 * reads are answered in-page — nothing is sent.
 */
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { ProjectDetailResponse, ProjectView, TeamState } from '@slopus/happy-wire';
import { storage } from '@/sync/storage';
import type { Machine, Session } from '@/sync/storageTypes';
import { setProjectsDevOverride } from '@/sync/projects';
import { setTeamNavigationDevOverride } from '@/screens/sessions/useTeamNavigation';
import { setCurrentAuth } from '@/auth/AuthContext';
import { Sidebar } from '@/screens/sessions/Sidebar';
import { ChatHeader } from '@/screens/session/ChatHeader';
import { TeamsScreen } from '@/screens/teams/TeamsScreen';
import { ProjectScreen } from '@/screens/projects/ProjectScreen';
import { useIsTablet } from '@/app/useMediaQuery';

const NOW = Date.now();
const session = (id: string, title: string, i: number): Session => ({
  id, seq: i, createdAt: NOW - i * 60_000, updatedAt: NOW - i * 60_000, active: true, activeAt: NOW - i * 60_000,
  metadata: { path: '/home/dev/demo', flavor: 'claude', host: 'devbox', machineId: 'm1', summary: { text: title, updatedAt: NOW } } as unknown as Session['metadata'],
  metadataVersion: 1, agentState: null, agentStateVersion: 1, thinking: false, thinkingAt: 0, presence: NOW,
});
const bot = (id: string, name: string, sessionId: string, root = false) => ({ id, name, sessionId, root, generation: 1, managed: true, assistant: 'claude', directory: null, lastEvent: 'idle', lastEventAt: NOW }) as TeamState['bots'][number];
const TEAMS: TeamState[] = [
  { id: 'team-pay', name: '支付研发队', machineId: 'm1', version: 1, createdAt: NOW - 7200_000, tasks: [], messages: [], operations: [],
    bots: [bot('pay-lead', 'Lead', 's-lead', true), bot('pay-fe', '前端-1', 's-fe'), bot('pay-be', '后端-1', 's-be')] },
  { id: 'team-solo', name: '临时调研队', machineId: 'm1', version: 1, createdAt: NOW - 600_000, tasks: [], messages: [], operations: [],
    bots: [bot('solo-lead', 'Lead', 's-solo', true)] },
];
const project = (id: string, name: string, teamIds: string[], createdAt: number): ProjectView => ({ id, name, goal: '示例项目：把退款与结算拆成独立服务。', instructions: '', instructionsVersion: 0, instructionsUpdatedBy: null, instructionsUpdatedAt: null, folders: [{ machineId: 'm1', path: '/home/dev/demo', primary: true }], defaults: {}, archivedAt: null, createdAt, updatedAt: createdAt, teamIds, automationIds: [] });
const PROJECTS = [project('pj-pay', '支付重构（示例）', ['team-pay'], NOW - 9000_000), project('pj-web', '官网改版（示例）', [], NOW - 8000_000)];
const MEMBERS = [{ projectId: 'pj-pay', sessionId: 's-plain', via: 'explicit', machineId: null, createdAt: NOW }];

function seed() {
  setCurrentAuth({ credentials: { token: 'dev-harness', secret: 'x' } } as never);
  storage.getState().applyMachines([{ id: 'm1', seq: 1, createdAt: NOW, updatedAt: NOW, active: true, activeAt: NOW, metadata: { host: 'devbox', platform: 'linux', teamLaunchVersion: 1 }, metadataVersion: 1, daemonState: null, daemonStateVersion: 1 } as unknown as Machine]);
  storage.getState().applySessions([
    session('s-lead', '拆分网关并分派', 1), session('s-fe', '结算页改造', 2), session('s-be', '退款接口迁移：把旧的同步回调换成队列消费，并补齐幂等键', 3),
    session('s-plain', '排查退款回调超时', 4), session('s-loose', '临时脚本', 5), session('s-solo', '调研三家网关的限流', 6),
  ]);
  setTeamNavigationDevOverride(TEAMS);
  setProjectsDevOverride({ status: 'ready', projects: PROJECTS, members: MEMBERS });
  storage.getState().applyReady();
  // Team / project page reads, answered locally (nothing leaves the page).
  const real = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    const team = url.match(/\/v1\/teams\/([^/?]+)$/);
    if (team) return json({ team: TEAMS.find((t) => t.id === decodeURIComponent(team[1])) });
    if (/\/v1\/teams(\?|$)/.test(url)) return json({ teams: TEAMS });
    const pj = url.match(/\/v1\/projects\/([^/?]+)$/);
    if (pj) {
      const p = PROJECTS.find((x) => x.id === decodeURIComponent(pj[1]))!;
      return json({ project: p, members: MEMBERS.filter((m) => m.projectId === p.id), presence: [], log: [] } satisfies ProjectDetailResponse);
    }
    if (url.includes('/v1/')) return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
    return real(input, init);
  };
}

export function LocationTrailHarness() {
  const params = useParams();
  const kind = params.sessionId ? 'session' : params.teamId ? 'team' : 'project';
  const id = params.sessionId ?? params.teamId ?? params.projectId;
  const [ready, setReady] = useState(false);
  const wide = useIsTablet();
  useEffect(() => { seed(); setReady(true); }, []);
  if (!ready || !id) return null;
  const main = kind === 'session'
    ? <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}><ChatHeader sessionId={id} /><p style={{ padding: 24, color: 'var(--text-dim)' }}>（示例对话）</p></div>
    : kind === 'team' ? <div style={{ flex: 1, minWidth: 0, overflow: 'auto' }}><TeamsScreen /></div>
    : <div style={{ flex: 1, minWidth: 0, overflow: 'auto' }}><ProjectScreen /></div>;
  return (
    <div style={{ display: 'flex', height: '100dvh', background: 'var(--bg-0)' }}>
      {wide && <div style={{ width: 300, display: 'flex', flexDirection: 'column', borderRight: '1px solid var(--line)', background: 'var(--surface-sidebar)' }}><Sidebar /></div>}
      {main}
    </div>
  );
}
