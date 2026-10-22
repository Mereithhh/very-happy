import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, FolderKanban, Settings2, Send, UsersRound, Zap, Undo2, Plus, Link2, LogOut } from 'lucide-react';
import { ActionDropdownMenu } from '@/ui/Menu';
import { linkableTeams } from './projectChoice';
import type { ProjectDetailResponse, ProjectLogEntryView, ProjectLogKind } from '@slopus/happy-wire';
import { applyLocalMembership, projectsApi, ProjectsApiError, refreshProjects, useProjects } from '@/sync/projects';
import { useAllMachines, useAllSessions, storage } from '@/sync/storage';
import { useBoardCompleted, useBoardItems } from '@/screens/board/useBoardItems';
import { attentionKeysOf } from '@/screens/sessions/sidebarAttention';
import { useTeamNavigation } from '@/screens/sessions/useTeamNavigation';
import { pendingSessions } from '@/sync/pendingSessionsRuntime';
import { normalizeAgentKey, resolveNewSessionPermissionMode } from '@/sync/agentDefaults';
import { getSessionName } from '@/utils/sessionUtils';
import { machineLabel } from '@/utils/machineUtils';
import { toast } from '@/ui/Toast';
import { Segmented } from '@/ui/Segmented';
import { SelectMenu } from '@/ui/SelectMenu';
import { bucketItems, injectionStateOf, summarizeInjection, type InjectionState } from './projectPage';
import { projectSettingsPath } from './projectSettings';
import { InstructionsEditor } from './ProjectSettingsScreen';
import { WorktreeFolderNotice } from './WorktreeFolderNotice';
import { useProjectCopy, type ProjectCopy } from './projectCopy';
import { useTranslation } from '@/i18n/useTranslation';
import { LocationTrail } from '@/components/LocationTrail';
import { projectTrail, trailCopy } from '@/app/locationTrail';
import './projects.css';

/**
 * B-648 project page `/projects/:id` (`specs/2026-10-projects.md` §6.2/§6.5).
 * Prompt first (Claude Code Projects): the composer starts a session in the
 * primary folder that joins the project before its first message. Two tabs:
 * 概览 — the board's own classification filtered to this project (so
 * 等你处理 equals the sidebar header and /board), teams, members with their
 * real injection state; 上下文 — instructions (CAS) and the log. Settings are
 * their own page (B-757, `/projects/:id/settings`), opened from the header.
 */
export function ProjectScreen() {
  const { projectId = '' } = useParams();
  const c = useProjectCopy();
  const [detail, setDetail] = useState<ProjectDetailResponse | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'missing' | 'unavailable'>('loading');
  const [tab, setTab] = useState<'overview' | 'context'>('overview');
  const trail = trailCopy(useTranslation().lang.startsWith('zh'));
  const navigate = useNavigate();

  const load = useCallback(async () => {
    try {
      const next = await projectsApi.get(projectId);
      setDetail(next);
      setState('ready');
    } catch (error) {
      if (error instanceof ProjectsApiError && error.unavailable) setState('unavailable');
      else if (error instanceof ProjectsApiError && error.code === 'project_not_found') setState('missing');
    }
  }, [projectId]);
  useEffect(() => {
    setState('loading');
    void load();
    const timer = setInterval(() => { if (!document.hidden) void load(); }, 15_000);
    return () => clearInterval(timer);
  }, [load]);
  const reload = useCallback(async () => { await load(); void refreshProjects(); }, [load]);

  if (state !== 'ready' || !detail) {
    return (
      <main className="pj-screen">
        <Link className="pj-back" to="/"><ArrowLeft size={16} />{c.back}</Link>
        <p className="pj-muted">{state === 'missing' ? c.notFound : state === 'unavailable' ? c.unavailable : c.loading}</p>
      </main>
    );
  }
  const project = detail.project;
  return (
    <main className="pj-screen">
      <header className="pj-head">
        <div className="pj-head-text">
          {/* B-763: 项目 › 名称 — the Projects list is the one ancestor (phones show the same two segments). */}
          <LocationTrail className="pj-trail" segments={projectTrail(trail)} label={trail.label}><span className="pj-trail-current">{project.name}</span></LocationTrail>
          <h1><FolderKanban size={22} aria-hidden />{project.name}</h1>
          {project.goal && <p className="pj-goal">{project.goal}</p>}
        </div>
        <Link className="pj-icon-btn" to={projectSettingsPath(project.id)} aria-label={c.settings} title={c.settings} data-testid="project-settings-link"><Settings2 size={18} /></Link>
      </header>
      <WorktreeFolderNotice detail={detail} c={c} onChanged={reload} onOpenSettings={() => navigate(projectSettingsPath(project.id, 'folders'))} />
      {/* B-728 (UI-P1-12): the empty state's action opens settings on the path field */}
      <ProjectComposer detail={detail} c={c} onAddFolder={() => navigate(projectSettingsPath(project.id, 'folders'))} />
      <div className="vh-segmented pj-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'overview'} className={tab === 'overview' ? 'is-active' : ''} onClick={() => setTab('overview')}>{c.overview}</button>
        <button type="button" role="tab" aria-selected={tab === 'context'} className={tab === 'context' ? 'is-active' : ''} onClick={() => setTab('context')}>{c.context}</button>
      </div>
      {tab === 'overview' ? <ProjectOverview detail={detail} c={c} onChanged={reload} /> : <ProjectContext detail={detail} c={c} onChanged={reload} />}
    </main>
  );
}

// ─── composer ────────────────────────────────────────────────────────────

function ProjectComposer({ detail, c, onAddFolder }: { detail: ProjectDetailResponse; c: ProjectCopy; onAddFolder: () => void }) {
  const navigate = useNavigate();
  const machines = useAllMachines({ includeOffline: true });
  const folders = detail.project.folders;
  const [folderIndex, setFolderIndex] = useState(() => Math.max(0, folders.findIndex((f) => f.primary)));
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const folder = folders[Math.min(folderIndex, folders.length - 1)];
  const machine = folder ? machines.find((m) => m.id === folder.machineId) : undefined;
  const send = () => {
    const first = text.trim();
    if (!folder || !first || busy) return;
    setBusy(true);
    const state = storage.getState();
    const defaults = detail.project.defaults;
    const agent = normalizeAgentKey(defaults.agent ?? state.settings.newSessionAgent);
    const permissionMode = resolveNewSessionPermissionMode(state.settings.agentDefaultOverrides, agent, state.localSettings.newSessionReviewFirst);
    const record = pendingSessions.create({
      machineId: folder.machineId, path: folder.path, agent, permissionMode, source: 'project',
      firstMessage: first, onSpawnedProject: { projectId: detail.project.id },
    });
    setText('');
    setBusy(false);
    navigate(`/session/${record.pendingId}`);
  };
  return (
    <div className="pj-composer">
      <textarea
        className="pj-composer-input"
        rows={2}
        value={text}
        placeholder={c.composerPlaceholder(detail.project.name)}
        disabled={!folder}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); } }}
      />
      <div className="pj-composer-bar">
        {folder ? (
          <div className="pj-composer-summary">
            <span className="pj-muted" aria-hidden="true">{c.folder}</span>
            <SelectMenu
              variant="soft"
              className="pj-folder-select"
              label={c.folder}
              value={String(Math.min(folderIndex, folders.length - 1))}
              onChange={(v) => setFolderIndex(Number(v))}
              options={folders.map((f, i) => ({ value: String(i), label: `${f.path}${f.primary ? ` · ${c.primary}` : ''}` }))}
            />
            {machine && <span className="pj-muted mono">{machineLabel(machine)}</span>}
          </div>
        ) : <span className="pj-composer-empty"><span className="pj-muted">{c.noFolder}</span><button type="button" className="pj-ghost" onClick={onAddFolder}><Plus size={14} />{c.addFolder}</button></span>}
        <button type="button" className="pj-send" disabled={!folder || !text.trim() || busy} onClick={send} aria-label={c.send} title={`${c.send} (⌘↵)`}><Send size={16} /></button>
      </div>
    </div>
  );
}

// ─── overview ────────────────────────────────────────────────────────────

function injectionLabel(s: InjectionState, c: ProjectCopy): string {
  switch (s.kind) {
    case 'current': return c.injected(s.version);
    case 'stale': return c.stale(s.version, s.latest);
    case 'pending': return c.pending;
    case 'none': return s.restartHelps ? c.noneRestart : c.none;
    default: return c.unknown;
  }
}

function ProjectOverview({ detail, c, onChanged }: { detail: ProjectDetailResponse; c: ProjectCopy; onChanged: () => Promise<void> }) {
  const navigate = useNavigate();
  const items = useBoardItems();
  const sessions = useAllSessions();
  const teams = useTeamNavigation();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(t); }, []);
  const completed = useBoardCompleted(now);
  const memberIds = useMemo(() => new Set(detail.members.map((m) => m.sessionId)), [detail.members]);
  const attentionKeys = useMemo(() => attentionKeysOf(items), [items]);
  const buckets = useMemo(() => bucketItems(items, memberIds, attentionKeys), [items, memberIds, attentionKeys]);
  const done = completed.filter((e) => e.kind === 'session' && e.href && memberIds.has(decodeURIComponent(e.href.replace(/^\/session\//, ''))));
  const sessionById = useMemo(() => new Map(sessions.map((s) => [s.id, s])), [sessions]);
  const presenceById = useMemo(() => new Map(detail.presence.map((p) => [p.sessionId, p])), [detail.presence]);
  const version = detail.project.instructionsVersion;
  const memberRows = detail.members.map((m) => {
    const session = sessionById.get(m.sessionId);
    const presence = presenceById.get(m.sessionId);
    const meta = session?.metadata as { capabilities?: string[]; flavor?: string | null; host?: string } | undefined;
    return { member: m, title: session ? getSessionName(session) : presence?.title ?? m.sessionId.slice(0, 10), agent: meta?.flavor ?? presence?.agent ?? null, machine: meta?.host ?? presence?.machine ?? null, doing: presence?.doing ?? null, injection: injectionStateOf(meta ?? null, presence, version) };
  });
  const summary = summarizeInjection(memberRows.map((r) => r.injection));
  const attachedTeams = teams.filter((t) => detail.project.teamIds.includes(t.id));
  const projects = useProjects();
  const linkable = linkableTeams(teams, detail.project.id, projects.status === 'ready' ? projects.projects : [detail.project]);
  const linkTeam = async (teamId: string) => {
    try { await projectsApi.attachTeam(detail.project.id, teamId); await onChanged(); }
    catch (error) { toast.error(error instanceof ProjectsApiError && error.code === 'team_machine_not_in_project' ? c.teamNoFolder : c.failed); }
  };
  const leave = async (sessionId: string) => {
    try { await projectsApi.removeMember(detail.project.id, sessionId); applyLocalMembership(null, [sessionId]); await onChanged(); }
    catch { toast.error(c.failed); }
  };
  const Bucket = ({ title, list, tone }: { title: string; list: { key: string; title: string; href: string }[]; tone?: 'attention' }) => (
    <section className="pj-bucket">
      <h2>{title}<span className={`pj-count${tone === 'attention' && list.length ? ' is-attention' : ''}`}>{list.length}</span></h2>
      {list.length === 0 ? <p className="pj-muted pj-empty">—</p> : list.map((item) => <Link key={item.key} className="pj-row" to={item.href}>{item.title || c.empty}</Link>)}
    </section>
  );
  const titled = (list: typeof items) => list.map((i) => ({ key: i.key, href: i.href, title: i.title || (sessionById.get(i.key) ? getSessionName(sessionById.get(i.key)!) : '') }));
  return (
    <div className="pj-overview">
      <div className="pj-buckets">
        <Bucket title={c.attention} list={titled(buckets.attention)} tone="attention" />
        <Bucket title={c.running} list={titled(buckets.running)} />
        <Bucket title={c.doneToday} list={done.map((e) => ({ key: e.key, href: e.href!, title: e.title }))} />
        <Bucket title={c.idle} list={titled(buckets.idle)} />
      </div>
      {/* B-726: the project is the team's context — teams live here, with「新建团队」and「关联已有团队」. */}
      <section className="pj-section pj-teams">
        <h2>{c.teams}
          <span className="pj-h-actions">
            <button type="button" className="pj-ghost" onClick={() => navigate(`/teams?new=1&project=${encodeURIComponent(detail.project.id)}`)}><Plus size={14} aria-hidden />{c.newTeamHere}</button>
            {linkable.length > 0 && <ActionDropdownMenu align="end" items={linkable.map((t) => ({ key: t.id, icon: UsersRound, label: t.name, onSelect: () => void linkTeam(t.id) }))}>
              <button type="button" className="pj-ghost"><Link2 size={14} aria-hidden />{c.linkTeam}</button>
            </ActionDropdownMenu>}
          </span>
        </h2>
        {attachedTeams.length === 0 ? <p className="pj-muted">{c.noTeams}</p> : attachedTeams.map((t) => <Link key={t.id} className="pj-row" to={`/teams/${encodeURIComponent(t.id)}`}><UsersRound size={15} aria-hidden />{t.name}</Link>)}
      </section>
      {detail.project.automationIds.length > 0 && (
        <section className="pj-section">
          <h2>{c.automations}</h2>
          {detail.project.automationIds.map((id) => <Link key={id} className="pj-row" to={`/automations/${encodeURIComponent(id)}`}><Zap size={15} aria-hidden />{id.slice(0, 8)}</Link>)}
        </section>
      )}
      <section className="pj-section">
        <h2>{c.members}<span className="pj-muted pj-h-note">{c.injectionSummary(summary.current, summary.stale + summary.pending, summary.none)}</span></h2>
        {memberRows.length === 0 ? <p className="pj-muted">{c.empty}</p> : memberRows.map((r) => (
          <div key={r.member.sessionId} className="pj-member-row">
            <Link className="pj-member" to={`/session/${encodeURIComponent(r.member.sessionId)}`}>
              <span className="pj-member-title">{r.title}</span>
              <span className="pj-muted pj-member-meta">{[r.member.via === 'team' ? c.viaTeam : null, r.agent, r.machine, r.doing].filter(Boolean).join(' · ')}</span>
              <span className={`pj-badge pj-badge--${r.injection.kind}`}>{injectionLabel(r.injection, c)}</span>
            </Link>
            {/* B-726: explicit members leave here; a team member follows its team (team settings). */}
            {r.member.via !== 'team' && <button type="button" className="pj-icon-btn pj-member-leave" title={c.removeFromProject} aria-label={`${c.removeFromProject}: ${r.title}`} onClick={() => void leave(r.member.sessionId)}><LogOut size={15} aria-hidden /></button>}
          </div>
        ))}
      </section>
    </div>
  );
}

// ─── context: instructions + log ─────────────────────────────────────────

function ProjectContext({ detail, c, onChanged }: { detail: ProjectDetailResponse; c: ProjectCopy; onChanged: () => Promise<void> }) {
  return (
    <div className="pj-context">
      <p className="pj-muted pj-trust">{c.serverVisible}</p>
      <section className="pj-section">
        <h2>{c.instructions}</h2>
        <p className="pj-muted pj-hint">{c.instructionsHint}</p>
        <InstructionsEditor detail={detail} c={c} editable={detail.project.archivedAt === null} onChanged={onChanged} />
      </section>
      <ProjectLog detail={detail} c={c} onChanged={onChanged} />
    </div>
  );
}

function ProjectLog({ detail, c, onChanged }: { detail: ProjectDetailResponse; c: ProjectCopy; onChanged: () => Promise<void> }) {
  const [kind, setKind] = useState<ProjectLogKind | 'all'>('all');
  const [newKind, setNewKind] = useState<ProjectLogKind>('decision');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const sessions = useAllSessions();
  const titleOf = (id: string | null) => {
    if (!id) return c.byUser;
    const s = sessions.find((x) => x.id === id);
    return s ? getSessionName(s) : detail.presence.find((p) => p.sessionId === id)?.title ?? id.slice(0, 8);
  };
  const entries = [...detail.log].reverse().filter((e) => kind === 'all' || e.kind === kind);
  const kindLabel = (k: ProjectLogKind) => (k === 'decision' ? c.decision : k === 'finding' ? c.finding : c.handoff);
  const add = async () => {
    if (!title.trim()) return;
    try { await projectsApi.addLog(detail.project.id, { kind: newKind, title: title.trim(), ...(body.trim() ? { body: body.trim() } : {}) }); setTitle(''); setBody(''); await onChanged(); }
    catch { toast.error(c.failed); }
  };
  const revoke = async (e: ProjectLogEntryView) => {
    try { await projectsApi.revokeLog(detail.project.id, e.id); await onChanged(); } catch { toast.error(c.failed); }
  };
  return (
    <section className="pj-section">
      <h2>{c.log}<span className="pj-h-actions vh-segmented pj-filter">
        {(['all', 'decision', 'finding', 'handoff'] as const).map((k) => <button type="button" key={k} className={kind === k ? 'is-active' : ''} onClick={() => setKind(k)}>{k === 'all' ? c.all : kindLabel(k)}</button>)}
      </span></h2>
      <p className="pj-muted pj-hint">{c.logHint}</p>
      <div className="pj-note-form">
        <Segmented<ProjectLogKind>
          className="pj-note-kind"
          label={c.addNote}
          value={newKind}
          onChange={setNewKind}
          options={[{ value: 'decision', label: c.decision }, { value: 'finding', label: c.finding }, { value: 'handoff', label: c.handoff }]}
        />
        <input value={title} maxLength={200} placeholder={c.titlePh} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void add(); }} />
        <button type="button" className="pj-primary" disabled={!title.trim()} onClick={() => void add()}><Plus size={14} />{c.addNote}</button>
        <textarea value={body} rows={2} placeholder={c.bodyPh} onChange={(e) => setBody(e.target.value)} />
      </div>
      {entries.length === 0 ? <p className="pj-muted">{c.noLog}</p> : (
        <ol className="pj-log">
          {entries.map((e) => (
            <li key={e.id} className={e.revokedAt || e.supersededBy ? 'is-inactive' : ''}>
              <div className="pj-log-head">
                <span className="mono pj-muted">#{e.seq}</span>
                <span className={`pj-kind pj-kind--${e.kind}`}>{kindLabel(e.kind)}</span>
                <strong>{e.title}</strong>
                {e.revokedAt ? <span className="pj-muted">· {c.revoked}</span> : e.supersededBy ? <span className="pj-muted">· {c.superseded}</span> : <button type="button" className="pj-ghost pj-revoke" onClick={() => void revoke(e)}><Undo2 size={13} />{c.revoke}</button>}
              </div>
              <div className="pj-muted pj-log-meta">{titleOf(e.authorSessionId)} · {new Date(e.createdAt).toLocaleString()}</div>
              {e.body && <p className="pj-log-body">{e.body}</p>}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
