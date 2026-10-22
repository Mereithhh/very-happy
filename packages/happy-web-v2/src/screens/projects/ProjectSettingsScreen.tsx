import { useCallback, useEffect, useId, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { Archive, ArchiveRestore, ArrowLeft, FolderOpen, History, Link2, LogOut, Pencil, Plus, Star, Trash2, Unlink, UsersRound } from 'lucide-react';
import { PROJECT_LIMITS, type ProjectDetailResponse, type ProjectInstructionsRevisionView, type ProjectView } from '@slopus/happy-wire';
import { applyLocalMembership, projectsApi, ProjectsApiError, refreshProjects, useProjects } from '@/sync/projects';
import { useAllMachines, useAllSessions } from '@/sync/storage';
import { useTeamNavigation } from '@/screens/sessions/useTeamNavigation';
import { getSessionName } from '@/utils/sessionUtils';
import { Modal } from '@/modal';
import { toast } from '@/ui/Toast';
import { Button } from '@/ui/Button';
import { Input } from '@/ui/Input';
import { Segmented } from '@/ui/Segmented';
import { ActionDropdownMenu } from '@/ui/Menu';
import { Markdown } from '@/screens/session/Markdown';
import { linkableTeams, teamMoveSource } from './projectChoice';
import { utf8Bytes, INSTRUCTIONS_MAX_BYTES } from './projectPage';
import { addFolder, basicsPatch, canRemoveMember, folderError, makePrimary, projectSettingsPolicy, removeFolder, updateFolder, PROJECT_SETTINGS_SECTIONS, type FolderDraft } from './projectSettings';
import { useProjectCopy, type ProjectCopy } from './projectCopy';
import { ProjectFolderPicker } from './ProjectFolderPicker';
import { expandHome, folderProblem, resolveProjectFolderDraft, type ProjectFolderDraft } from './projectFolderDraft';
import { machineFsMkdir } from '@/sync/fsOps';
import { isMachineOnline, machineLabel } from '@/utils/machineUtils';
import { useTranslation } from '@/i18n/useTranslation';
import { WorktreeFolderNotice } from './WorktreeFolderNotice';
import './projects.css';

/**
 * B-757 project settings `/projects/:id/settings` — the project's
 * counterpart of the team settings tab: 基本信息 / 项目说明 / 目录 / 关联团队 /
 * 成员会话 / 危险区, one section per concern, each saving on its own. Section
 * anchors (`#folders` …) are the deep links other entry points use.
 */
export function ProjectSettingsScreen() {
  const { projectId = '' } = useParams();
  const c = useProjectCopy();
  const location = useLocation();
  const [detail, setDetail] = useState<ProjectDetailResponse | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'missing' | 'unavailable'>('loading');

  const load = useCallback(async () => {
    try {
      setDetail(await projectsApi.get(projectId));
      setState('ready');
    } catch (error) {
      if (error instanceof ProjectsApiError && error.unavailable) setState('unavailable');
      else if (error instanceof ProjectsApiError && error.code === 'project_not_found') setState('missing');
    }
  }, [projectId]);
  useEffect(() => { setState('loading'); void load(); }, [load]);
  const reload = useCallback(async () => { await load(); void refreshProjects(); }, [load]);

  // Deep link: scroll the anchored section in once the page has content.
  const ready = state === 'ready';
  useEffect(() => {
    const section = location.hash.slice(1);
    if (!ready || !(PROJECT_SETTINGS_SECTIONS as readonly string[]).includes(section)) return;
    document.getElementById(`pj-settings-${section}`)?.scrollIntoView({ block: 'start' });
    // B-728 (UI-P1-12): the composer's「添加目录」lands on the path field.
    if (section === 'folders' && detail?.project.folders.length === 0) document.querySelector<HTMLInputElement>(FOLDER_ADD_SELECTOR)?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, location.hash]);

  if (state !== 'ready' || !detail) {
    return (
      <main className="pj-screen">
        <Link className="pj-back" to="/"><ArrowLeft size={16} />{c.back}</Link>
        <p className="pj-muted">{state === 'missing' ? c.notFound : state === 'unavailable' ? c.unavailable : c.loading}</p>
      </main>
    );
  }
  const project = detail.project;
  const policy = projectSettingsPolicy(project);
  return (
    <main className="pj-screen pj-settings-page" data-testid="project-settings">
      <header className="pj-head">
        <div className="pj-head-text">
          <Link className="pj-back" to={`/projects/${encodeURIComponent(project.id)}`}><ArrowLeft size={16} />{c.backTo(project.name)}</Link>
          <h1>{c.settings}</h1>
        </div>
      </header>
      <nav className="pj-settings-nav" aria-label={c.settings}>
        {PROJECT_SETTINGS_SECTIONS.map((s) => <a key={s} href={`#${s}`} onClick={(e) => { e.preventDefault(); document.getElementById(`pj-settings-${s}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' }); history.replaceState(history.state, '', `#${s}`); }}>{sectionTitle(s, c)}</a>)}
      </nav>
      {!policy.editable && <p className="pj-archived-note" role="status">{c.archivedNote}</p>}
      <BasicsSection key={`basics:${project.updatedAt}`} project={project} c={c} editable={policy.editable} onChanged={reload} />
      <section id="pj-settings-context" className="pj-section">
        <h2>{c.contextTitle}</h2>
        <p className="pj-muted pj-hint">{c.contextHint}</p>
        <InstructionsEditor detail={detail} c={c} editable={policy.editable} onChanged={reload} />
      </section>
      <FoldersSection project={project} c={c} editable={policy.editable} onChanged={reload} />
      <TeamsSection project={project} c={c} editable={policy.editable} onChanged={reload} />
      <SessionsSection detail={detail} c={c} onChanged={reload} />
      <DangerSection project={project} c={c} onChanged={reload} />
    </main>
  );
}

function sectionTitle(s: (typeof PROJECT_SETTINGS_SECTIONS)[number], c: ProjectCopy): string {
  switch (s) {
    case 'basics': return c.basics;
    case 'context': return c.contextTitle;
    case 'folders': return c.folders;
    case 'teams': return c.teams;
    case 'sessions': return c.sessions;
    default: return c.danger;
  }
}

type SectionProps = { project: ProjectView; c: ProjectCopy; editable: boolean; onChanged: () => Promise<void> };

/** Runs a write with the button busy; failures toast (the form keeps what was typed). */
function useWrite(c: ProjectCopy, onChanged: () => Promise<void>) {
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (key: string, work: () => Promise<unknown>): Promise<boolean> => {
    setBusy(key);
    try { await work(); await onChanged(); return true; }
    catch { toast.error(c.failed); return false; }
    finally { setBusy(null); }
  };
  return { busy, run };
}

// ─── 基本信息 ────────────────────────────────────────────────────────────

function BasicsSection({ project, c, editable, onChanged }: SectionProps) {
  const [name, setName] = useState(project.name);
  const [goal, setGoal] = useState(project.goal ?? '');
  const { busy, run } = useWrite(c, onChanged);
  const patch = basicsPatch(project, name, goal);
  const save = () => { if (patch) void run('basics', async () => { await projectsApi.update(project.id, patch); toast.success(c.saved); }); };
  return (
    <section id="pj-settings-basics" className="pj-section">
      <h2>{c.basics}</h2>
      <p className="pj-muted pj-hint">{c.basicsHint}</p>
      <form className="pj-form" onSubmit={(e) => { e.preventDefault(); save(); }}>
        <Input label={c.rename} value={name} maxLength={PROJECT_LIMITS.nameChars} disabled={!editable} onChange={(e) => setName(e.target.value)} error={editable && !name.trim() ? c.nameRequired : null} />
        <Input label={c.description} value={goal} maxLength={PROJECT_LIMITS.goalChars} placeholder={c.descriptionPh} disabled={!editable} onChange={(e) => setGoal(e.target.value)} />
        {editable && <div className="pj-form-foot"><Button type="submit" variant="primary" size="sm" disabled={!patch} loading={busy === 'basics'}>{c.save}</Button></div>}
      </form>
    </section>
  );
}

// ─── 项目说明（编辑 + 预览，CAS） ─────────────────────────────────────────

/**
 * Instructions with 编辑 / 预览 (the same Markdown renderer as the chat) and a
 * compare-and-set save: a 409 loads the newer text and says so instead of
 * overwriting it. Shared by the settings page and the project page's 上下文 tab.
 */
export function InstructionsEditor({ detail, c, editable, onChanged }: { detail: ProjectDetailResponse; c: ProjectCopy; editable: boolean; onChanged: () => Promise<void> }) {
  const project = detail.project;
  const [draft, setDraft] = useState(project.instructions);
  const [base, setBase] = useState(project.instructionsVersion);
  const [mode, setMode] = useState<'write' | 'preview'>(project.instructions.trim() ? 'preview' : 'write');
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [history, setHistory] = useState<ProjectInstructionsRevisionView[] | null>(null);
  // A save elsewhere (another tab, an agent-facing write) moves the base while this draft is untouched.
  const dirty = draft !== project.instructions;
  useEffect(() => {
    if (!dirty) { setDraft(project.instructions); setBase(project.instructionsVersion); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.instructions, project.instructionsVersion]);
  const bytes = utf8Bytes(draft);
  const tooLong = bytes > INSTRUCTIONS_MAX_BYTES;
  const delivered = detail.presence.filter((p) => p.injectedInstructionsVersion === project.instructionsVersion).length;
  const older = detail.presence.filter((p) => typeof p.injectedInstructionsVersion === 'number' && p.injectedInstructionsVersion < project.instructionsVersion).length;
  const save = async () => {
    setSaving(true);
    try {
      await projectsApi.putInstructions(project.id, { instructions: draft, ifVersion: base });
      setNotice(null);
      toast.success(c.saved);
      await onChanged();
    } catch (error) {
      if (error instanceof ProjectsApiError && error.code === 'instructions_version_conflict') {
        const latest = (error.details?.project ?? null) as { instructions?: string; instructionsVersion?: number } | null;
        if (latest?.instructionsVersion !== undefined) { setDraft(latest.instructions ?? ''); setBase(latest.instructionsVersion); setNotice(c.conflict(latest.instructionsVersion)); }
      } else toast.error(c.failed);
    } finally { setSaving(false); }
  };
  const editorId = useId();
  return (
    <div className="pj-instr" data-testid="project-instructions">
      <div className="pj-instr-bar">
        <Segmented<'write' | 'preview'> className="pj-instr-mode" label={c.contextTitle} value={mode} onChange={setMode}
          options={[{ value: 'write', label: c.write, disabled: !editable }, { value: 'preview', label: c.preview }]} />
        <span className="pj-muted pj-h-note">{c.versionLine(project.instructionsVersion, delivered, older)}</span>
        <Button variant="ghost" size="sm" className="pj-instr-history" leftIcon={<History size={14} />}
          onClick={async () => { try { setHistory(history ? null : (await projectsApi.history(project.id)).revisions); } catch { toast.error(c.failed); } }}>{c.history}</Button>
      </div>
      {notice && <p role="alert" className="pj-alert">{notice}</p>}
      {mode === 'write' && editable
        ? <textarea id={editorId} className="pj-instr-input" value={draft} rows={12} aria-label={c.contextTitle} placeholder={c.contextHint} onChange={(e) => setDraft(e.target.value)} />
        : <div className="pj-instr-preview">{draft.trim() ? <Markdown text={draft} trustContent /> : <p className="pj-muted">{editable ? c.previewEmpty : c.noInstructions}</p>}</div>}
      {editable && (
        <div className="pj-editor-bar">
          <span className={tooLong ? 'pj-alert-text' : 'pj-muted pj-h-note'} aria-live="polite">{tooLong ? c.tooLong : c.bytes(bytes, INSTRUCTIONS_MAX_BYTES)}</span>
          <Button variant="ghost" size="sm" disabled={!dirty || saving} onClick={() => { setDraft(project.instructions); setBase(project.instructionsVersion); setNotice(null); }}>{c.cancel}</Button>
          <Button variant="primary" size="sm" disabled={!dirty || tooLong} loading={saving} onClick={() => void save()}>{c.save}</Button>
        </div>
      )}
      {history && <ol className="pj-history">{history.map((h) => <li key={h.version}><span className="mono">v{h.version}</span> <span className="pj-muted">{new Date(h.createdAt).toLocaleString()}{h.summary ? ` · ${h.summary}` : ''}</span><pre>{h.instructions}</pre></li>)}</ol>}
    </div>
  );
}

// ─── 目录 ────────────────────────────────────────────────────────────────

/** The add-folder path field (deep link `#folders` focuses it on a project without folders). */
export const FOLDER_ADD_SELECTOR = '#pj-settings-folders .pj-folder-add .pj-folder-picker input';

/**
 * B-757 + B-755: one folder form — B-755's ProjectFolderPicker (an existing
 * folder, or a new working folder the daemon creates; team worktrees refused)
 * plus the project-level rules (no duplicate on the same machine, the 20-folder
 * limit) checked on the resolved path.
 */
function FolderForm({ c, initial, folders, index, busy, onSubmit, onCancel }: {
  c: ProjectCopy; initial: FolderDraft; folders: ProjectView['folders']; index?: number; busy: boolean;
  onSubmit: (draft: FolderDraft) => Promise<boolean>; onCancel?: () => void;
}) {
  const zh = useTranslation().lang.startsWith('zh');
  const machines = useAllMachines({ includeOffline: true });
  const [draft, setDraft] = useState<ProjectFolderDraft>({ machineId: initial.machineId, mode: 'existing', path: initial.path, gitInit: true });
  const [tried, setTried] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const machine = machines.find((m) => m.id === draft.machineId);
  const problem = folderProblem(draft, machine, !!machine && isMachineOnline(machine));
  const clash = draft.mode === 'existing' ? folderError(folders, { machineId: draft.machineId, path: expandHome(draft.path, machine?.metadata?.homeDir) }, index) : null;
  const shownClash = clash === 'duplicate' || clash === 'limit' ? clash : null;
  const submit = async () => {
    setTried(true); setNote(null);
    if (problem || shownClash || resolving || busy) return;
    setResolving(true);
    try {
      const resolved = await resolveProjectFolderDraft(draft, machine?.metadata?.homeDir, machineFsMkdir);
      if (!resolved.ok) { setNote(resolved.code === 'exists' ? c.folderExists : `${c.failed} (${resolved.code})`); if (resolved.code === 'exists') setDraft((d) => ({ ...d, mode: 'existing' })); return; }
      const after = folderError(folders, resolved.folder, index);
      if (after === 'duplicate' || after === 'limit') { setNote(c.folderErr[after]); return; }
      await onSubmit(resolved.folder);
    } finally { setResolving(false); }
  };
  return (
    <form className={`pj-folder-form${index === undefined ? ' pj-folder-add' : ''}`} onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <ProjectFolderPicker value={draft} onChange={(next) => { setNote(null); setDraft(next); }} zh={zh} showProblem={tried} />
      {(shownClash || note) && <p className="pj-folder-problem" role="alert">{note ?? c.folderErr[shownClash!]}</p>}
      <div className="pj-form-foot">
        {onCancel && <Button variant="ghost" size="sm" onClick={onCancel}>{c.cancel}</Button>}
        <Button type="submit" variant={index === undefined ? 'secondary' : 'primary'} size="sm" loading={busy || resolving} leftIcon={index === undefined ? <Plus size={14} /> : undefined}>{index === undefined ? c.addFolder : c.save}</Button>
      </div>
    </form>
  );
}

function FoldersSection({ project, c, editable, onChanged }: SectionProps) {
  const machines = useAllMachines({ includeOffline: true });
  const [editing, setEditing] = useState<number | null>(null);
  const [addKey, setAddKey] = useState(0);
  const { busy, run } = useWrite(c, onChanged);
  const folders = project.folders;
  const save = (key: string, next: ProjectView['folders']) => run(key, () => projectsApi.update(project.id, { folders: next }));
  const label = (machineId: string) => machineLabel(machines.find((m) => m.id === machineId) ?? ({ id: machineId } as never));
  return (
    <section id="pj-settings-folders" className="pj-section">
      <h2>{c.folders}<span className="pj-count">{folders.length}</span></h2>
      <p className="pj-muted pj-hint">{c.foldersHint}</p>
      {/* B-755 repair: a folder that is a team member's temporary worktree, and the repository to use instead. */}
      {editable && <WorktreeFolderNotice detail={{ project }} c={c} onChanged={onChanged} />}
      {folders.length === 0 && <p className="pj-muted">{c.noFolders}</p>}
      <ul className="pj-list">
        {folders.map((f, i) => (
          <li key={`${f.machineId}:${f.path}`} className="pj-list-row" data-testid="project-folder">
            {editing === i ? (
              <FolderForm c={c} folders={folders} index={i} initial={{ machineId: f.machineId, path: f.path }} busy={busy === `edit:${i}`}
                onCancel={() => setEditing(null)} onSubmit={async (draft) => { const ok = await save(`edit:${i}`, updateFolder(folders, i, draft)); if (ok) setEditing(null); return ok; }} />
            ) : (
              <>
                <FolderOpen size={15} aria-hidden className="pj-list-icon" />
                <span className="pj-list-main"><span className="mono pj-list-title" title={f.path}>{f.path}</span><span className="pj-muted pj-list-meta">{label(f.machineId)}</span></span>
                {f.primary && <span className="pj-badge pj-badge--inline">{c.primary}</span>}
                {editable && <span className="pj-list-actions">
                  {!f.primary && <Button variant="ghost" size="sm" leftIcon={<Star size={14} />} loading={busy === `primary:${i}`} onClick={() => void save(`primary:${i}`, makePrimary(folders, i))}>{c.makePrimary}</Button>}
                  <Button variant="ghost" size="sm" leftIcon={<Pencil size={14} />} onClick={() => setEditing(i)}>{c.change}</Button>
                  <Button variant="ghost" size="sm" leftIcon={<Trash2 size={14} />} loading={busy === `remove:${i}`}
                    onClick={async () => { if (await Modal.confirm(c.removeFolderTitle, c.removeFolderBody(f.path), { confirmText: c.remove, destructive: true })) void save(`remove:${i}`, removeFolder(folders, i)); }}>{c.remove}</Button>
                </span>}
              </>
            )}
          </li>
        ))}
      </ul>
      {editable && folders.length < PROJECT_LIMITS.folders && (
        <FolderForm key={addKey} c={c} folders={folders} initial={{ machineId: folders[0]?.machineId ?? machines[0]?.id ?? '', path: '' }} busy={busy === 'add'}
          onSubmit={async (draft) => { const ok = await save('add', addFolder(folders, draft)); if (ok) setAddKey((k) => k + 1); return ok; }} />
      )}
    </section>
  );
}

// ─── 关联团队 ────────────────────────────────────────────────────────────

function TeamsSection({ project, c, editable, onChanged }: SectionProps) {
  const navigate = useNavigate();
  const teams = useTeamNavigation();
  const projects = useProjects();
  const { busy, run } = useWrite(c, onChanged);
  const attached = project.teamIds.map((id) => ({ id, name: teams.find((t) => t.id === id)?.name ?? id.slice(0, 8) }));
  const known = projects.status === 'ready' ? projects.projects : [project];
  const linkable = linkableTeams(teams, project.id, known);
  const [linkError, setLinkError] = useState<string | null>(null);
  const link = async (teamId: string) => {
    setLinkError(null);
    const from = teamMoveSource({ id: teamId }, project.id, known);
    const name = teams.find((t) => t.id === teamId)?.name ?? teamId.slice(0, 8);
    if (from && !(await Modal.confirm(c.moveTeamTitle, c.moveTeamBody(name, from.name, project.name), { confirmText: c.moveTeam }))) return;
    try { await projectsApi.attachTeam(project.id, teamId); await onChanged(); }
    catch (error) { setLinkError(error instanceof ProjectsApiError && error.code === 'team_machine_not_in_project' ? c.teamNoFolder : c.failed); }
  };
  return (
    <section id="pj-settings-teams" className="pj-section">
      <h2>{c.teams}<span className="pj-count">{attached.length}</span>
        {editable && <span className="pj-h-actions">
          <Button variant="ghost" size="sm" leftIcon={<Plus size={14} />} onClick={() => navigate(`/teams?new=1&project=${encodeURIComponent(project.id)}`)}>{c.newTeamHere}</Button>
          {linkable.length > 0 && <ActionDropdownMenu align="end" items={linkable.map((t) => ({ key: t.id, icon: UsersRound, label: t.name, onSelect: () => void link(t.id) }))}>
            <Button variant="ghost" size="sm" leftIcon={<Link2 size={14} />}>{c.linkTeam}</Button>
          </ActionDropdownMenu>}
        </span>}
      </h2>
      {attached.length > 0 && <p className="pj-muted pj-hint">{c.teamsHint}</p>}
      {linkError && <p role="alert" className="pj-alert">{linkError}</p>}
      {attached.length === 0 ? <p className="pj-muted">{c.noTeams}</p> : (
        <ul className="pj-list">
          {attached.map((t) => (
            <li key={t.id} className="pj-list-row" data-testid="project-team">
              <UsersRound size={15} aria-hidden className="pj-list-icon" />
              <Link className="pj-list-main pj-list-title" to={`/teams/${encodeURIComponent(t.id)}`}>{t.name}</Link>
              {editable && <span className="pj-list-actions">
                <Button variant="ghost" size="sm" leftIcon={<Unlink size={14} />} loading={busy === `detach:${t.id}`}
                  onClick={async () => { if (await Modal.confirm(c.detachTitle, c.detachBody(t.name), { confirmText: c.detach })) void run(`detach:${t.id}`, () => projectsApi.detachTeam(project.id, t.id)); }}>{c.detach}</Button>
              </span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ─── 成员会话 ────────────────────────────────────────────────────────────

function SessionsSection({ detail, c, onChanged }: { detail: ProjectDetailResponse; c: ProjectCopy; onChanged: () => Promise<void> }) {
  const sessions = useAllSessions();
  const teams = useTeamNavigation();
  const { busy, run } = useWrite(c, onChanged);
  const project = detail.project;
  const rows = detail.members.map((m) => {
    const session = sessions.find((s) => s.id === m.sessionId);
    const presence = detail.presence.find((p) => p.sessionId === m.sessionId);
    const meta = session?.metadata as { flavor?: string | null; host?: string } | undefined;
    const team = m.teamId ? teams.find((t) => t.id === m.teamId)?.name ?? null : null;
    return {
      member: m,
      title: session ? getSessionName(session) : presence?.title ?? m.sessionId.slice(0, 10),
      meta: [m.via === 'team' ? (team ? `${c.viaTeam} · ${team}` : c.viaTeam) : null, meta?.flavor ?? presence?.agent ?? null, meta?.host ?? presence?.machine ?? null].filter(Boolean).join(' · '),
    };
  });
  return (
    <section id="pj-settings-sessions" className="pj-section">
      <h2>{c.sessions}<span className="pj-count">{rows.length}</span></h2>
      <p className="pj-muted pj-hint">{c.sessionsHint}</p>
      {rows.length === 0 ? <p className="pj-muted">{c.empty}</p> : (
        <ul className="pj-list">
          {rows.map((r) => (
            <li key={r.member.sessionId} className="pj-list-row" data-testid="project-member">
              <Link className="pj-list-main" to={`/session/${encodeURIComponent(r.member.sessionId)}`}>
                <span className="pj-list-title">{r.title}</span>
                {r.meta && <span className="pj-muted pj-list-meta">{r.meta}</span>}
              </Link>
              <span className="pj-list-actions">
                {canRemoveMember(r.member, project)
                  ? <Button variant="ghost" size="sm" leftIcon={<LogOut size={14} />} aria-label={`${c.removeFromProject}: ${r.title}`} loading={busy === r.member.sessionId}
                    onClick={async () => {
                      if (!await Modal.confirm(c.removeMemberTitle, c.removeMemberBody(r.title), { confirmText: c.removeFromProject })) return;
                      void run(r.member.sessionId, async () => { await projectsApi.removeMember(project.id, r.member.sessionId); applyLocalMembership(null, [r.member.sessionId]); });
                    }}><span className="pj-btn-label">{c.removeFromProject}</span></Button>
                  : r.member.via === 'team' && <span className="pj-muted pj-list-meta">{c.followsTeam}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ─── 危险区 ──────────────────────────────────────────────────────────────

function DangerSection({ project, c, onChanged }: Omit<SectionProps, 'editable'>) {
  const navigate = useNavigate();
  const policy = projectSettingsPolicy(project);
  const { busy, run } = useWrite(c, onChanged);
  const [deleting, setDeleting] = useState(false);
  const toggleArchive = async () => {
    if (policy.canArchive && !await Modal.confirm(c.archive, c.archiveConfirm, { confirmText: c.archive })) return;
    void run('archive', () => projectsApi.update(project.id, { archived: policy.canArchive }));
  };
  const remove = async () => {
    if (!await Modal.confirm(c.delete, c.deleteConfirm, { confirmText: c.delete, destructive: true })) return;
    setDeleting(true);
    try { await projectsApi.remove(project.id); void refreshProjects(); navigate('/'); }
    catch { toast.error(c.failed); setDeleting(false); }
  };
  return (
    <section id="pj-settings-danger" className="pj-section pj-danger-zone">
      <h2>{c.danger}</h2>
      <div className="pj-danger-item">
        <p className="pj-muted">{c.archiveHint}</p>
        <Button variant="secondary" size="sm" leftIcon={policy.canArchive ? <Archive size={14} /> : <ArchiveRestore size={14} />} loading={busy === 'archive'} onClick={() => void toggleArchive()}>{policy.canArchive ? c.archive : c.unarchive}</Button>
      </div>
      <div className="pj-danger-item">
        <p className="pj-muted">{c.deleteHint}</p>
        <Button variant="danger" size="sm" leftIcon={<Trash2 size={14} />} loading={deleting} onClick={() => void remove()}>{c.delete}</Button>
      </div>
    </section>
  );
}
