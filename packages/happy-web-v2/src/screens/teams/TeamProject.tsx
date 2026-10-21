import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { FolderKanban, FolderPlus } from 'lucide-react';
import type { TeamState } from '@slopus/happy-wire';
import { bindTeamProject, TeamsApiError } from '@/sync/teams';
import { refreshProjects, useProjects } from '@/sync/projects';
import { useTranslation } from '@/i18n/useTranslation';
import { toast } from '@/ui/Toast';
import { ProjectPicker } from '@/screens/projects/ProjectPicker';
import { projectOfTeam, type ProjectChoice } from '@/screens/projects/projectChoice';
import { TeamDialog } from './TeamDialog';

/**
 * B-726 (`specs/2026-10-team-project.md`): the team side of「团队属于一个项目」.
 * The project is the team's shared context, so every team surface shows it
 * and can change it: a header line (→ project page), a nudge for teams that
 * have none (one click: same-name project), and the settings picker
 * (change / detach, detach confirmed). All three read the shared projects
 * snapshot and refresh it after a bind.
 */
function useCopy() {
  const zh = useTranslation().lang.startsWith('zh');
  return zh ? {
    project: '所属项目', open: '打开项目', none: '不放进项目',
    nudge: '把团队放进项目，让成员共享上下文', nudgeHint: '负责人和成员会读到项目的说明和记录，团队的决定和交接也会记在项目里。',
    createSame: '创建同名项目并关联', pickExisting: '选择已有项目',
    settingsHint: '团队的上下文就是所属项目的上下文：成员读项目说明与记录，并用 project_note 记录决定和交接。改动对成员的下一轮生效。',
    detachTitle: '解绑项目？', detachBody: (name: string) => `解绑后，团队成员不再读到「${name}」的说明和记录，也不再出现在项目里。项目本身和已有记录都会保留。`,
    detach: '解绑', cancel: '取消', failed: '没能更新所属项目', unsupported: '服务器版本过旧，暂不支持在这里修改所属项目',
  } : {
    project: 'Project', open: 'Open project', none: 'No project',
    nudge: 'Put this team in a project so members share context', nudgeHint: 'The lead and members read the project’s instructions and log, and the team’s decisions and handoffs are recorded there.',
    createSame: 'Create a project with the same name', pickExisting: 'Choose a project',
    settingsHint: 'A team’s context is its project’s context: members read the project instructions and log, and record decisions and handoffs with project_note. Changes reach members on their next turn.',
    detachTitle: 'Remove from project?', detachBody: (name: string) => `Members of this team will no longer read the instructions and log of "${name}" or appear in it. The project and its log are kept.`,
    detach: 'Remove', cancel: 'Cancel', failed: 'Could not update the project', unsupported: 'This server is too old to change the team’s project here',
  };
}

function useBind(team: TeamState) {
  const c = useCopy();
  const [busy, setBusy] = useState(false);
  const createRequest = useRef<string>('');
  const bind = async (choice: ProjectChoice) => {
    setBusy(true);
    try {
      if (choice.kind === 'new') {
        createRequest.current ||= crypto.randomUUID();
        await bindTeamProject(team.id, { create: true, requestId: createRequest.current });
        createRequest.current = '';
      } else {
        await bindTeamProject(team.id, { projectId: choice.kind === 'existing' ? choice.projectId : null });
      }
      await refreshProjects();
    } catch (error) {
      toast.error(error instanceof TeamsApiError && error.status === 404 && error.code.startsWith('http_') ? c.unsupported : c.failed);
    } finally {
      setBusy(false);
    }
  };
  return { busy, bind };
}

/** Header line under the team name: 所属项目 · <link to the project page>. */
export function TeamProjectLine({ team }: { team: TeamState }) {
  const c = useCopy();
  const snap = useProjects();
  const project = snap.status === 'ready' ? projectOfTeam(team, snap.projects) : null;
  if (!project) return null;
  return <p className="team-project-line"><FolderKanban size={15} aria-hidden />{c.project} · <Link to={`/projects/${encodeURIComponent(project.id)}`} title={c.open}>{project.name}</Link></p>;
}

/** Overview nudge for a team without a project (old teams): one click makes a same-name project. */
export function TeamProjectNudge({ team }: { team: TeamState }) {
  const c = useCopy();
  const snap = useProjects();
  const { busy, bind } = useBind(team);
  const [choice, setChoice] = useState<ProjectChoice>({ kind: 'none' });
  if (snap.status !== 'ready' || team.archivedAt !== undefined || projectOfTeam(team, snap.projects)) return null;
  const others = snap.projects.filter((p) => !p.archivedAt);
  return (
    <section className="team-project-nudge" aria-label={c.nudge}>
      <FolderKanban size={18} aria-hidden className="team-project-nudge-icon" />
      <div className="team-project-nudge-text"><strong>{c.nudge}</strong><p>{c.nudgeHint}</p></div>
      <div className="team-project-nudge-actions">
        <button type="button" className="teams-primary" disabled={busy} aria-busy={busy || undefined} onClick={() => void bind({ kind: 'new' })}><FolderPlus size={16} aria-hidden />{c.createSame}</button>
        {others.length > 0 && <div className="team-project-nudge-pick"><ProjectPicker value={choice} onChange={(next) => { setChoice(next); if (next.kind === 'existing') void bind(next); }} projects={others} noneLabel={c.pickExisting} disabled={busy} /></div>}
      </div>
    </section>
  );
}

/** Team settings: change or detach the project (detach asks first). */
export function TeamProjectSettings({ team, disabled }: { team: TeamState; disabled: boolean }) {
  const c = useCopy();
  const snap = useProjects();
  const { busy, bind } = useBind(team);
  const [confirmDetach, setConfirmDetach] = useState(false);
  if (snap.status !== 'ready') return null;
  const current = projectOfTeam(team, snap.projects);
  const value: ProjectChoice = current ? { kind: 'existing', projectId: current.id } : { kind: 'none' };
  return (
    <section className="team-project-settings">
      <h2>{c.project}</h2>
      <p>{c.settingsHint}</p>
      <ProjectPicker id="team-settings-project" value={value} projects={snap.projects} newName={team.name} noneLabel={c.none} disabled={disabled || busy || team.archivedAt !== undefined}
        onChange={(next) => {
          if (next.kind === 'existing' && next.projectId === current?.id) return;
          if (next.kind === 'none') { if (current) setConfirmDetach(true); return; }
          void bind(next);
        }} />
      {current && <p className="team-project-line"><Link to={`/projects/${encodeURIComponent(current.id)}`}>{c.open} →</Link></p>}
      {confirmDetach && current && <TeamDialog title={c.detachTitle} onClose={() => setConfirmDetach(false)}>
        <p>{c.detachBody(current.name)}</p>
        <div className="team-project-confirm">
          <button type="button" onClick={() => setConfirmDetach(false)}>{c.cancel}</button>
          <button type="button" className="teams-danger" disabled={busy} onClick={async () => { await bind({ kind: 'none' }); setConfirmDetach(false); }}>{c.detach}</button>
        </div>
      </TeamDialog>}
    </section>
  );
}
