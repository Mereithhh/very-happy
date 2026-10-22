import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { TeamState } from '@slopus/happy-wire';
import { Button } from '@/ui';
import { DialogHead } from '@/ui/DialogHead';
import { useTranslation } from '@/i18n/useTranslation';
import { useProjects } from '@/sync/projects';
import { useTeamProjectBind } from '@/screens/teams/teamProjectBind';
import { ProjectPicker } from './ProjectPicker';
import { projectOfTeam, type ProjectChoice } from './projectChoice';
import '@/screens/sessions/newsession.css';
import './projects.css';

/**
 * B-763 「换项目…」 from the team row and team page menus: the team-settings
 * picker (B-726) in a dialog — same bind, same same-name create, and removing
 * the team from its project says what members lose before it happens.
 */
export function ChangeTeamProjectModal({ team, onClose }: { team: Pick<TeamState, 'id' | 'name'>; onClose: () => void }) {
  const zh = useTranslation().lang.startsWith('zh');
  const c = zh ? {
    title: '换项目', project: '所属项目', none: '不放进项目', apply: '确定', detach: '解绑', cancel: '取消',
    hint: '团队成员读所属项目的说明与记录，改动对成员的下一轮生效。',
    detachBody: (name: string) => `解绑后，团队成员不再读到「${name}」的说明和记录，也不再出现在项目里。项目本身和已有记录都会保留。`,
    failed: '没能更新所属项目', unsupported: '服务器版本过旧，暂不支持在这里修改所属项目',
  } : {
    title: 'Change project', project: 'Project', none: 'No project', apply: 'Apply', detach: 'Remove', cancel: 'Cancel',
    hint: 'Team members read the project’s instructions and log; a change reaches them on their next turn.',
    detachBody: (name: string) => `Members of this team will no longer read the instructions and log of "${name}" or appear in it. The project and its log are kept.`,
    failed: 'Could not update the project', unsupported: 'This server is too old to change the team’s project here',
  };
  const snap = useProjects();
  const current = projectOfTeam(team, snap.projects);
  const [target, setTarget] = useState<ProjectChoice>(() => current ? { kind: 'existing', projectId: current.id } : { kind: 'none' });
  const { busy, bind } = useTeamProjectBind(team, c);
  useEffect(() => { document.getElementById('ctp-project')?.focus(); }, []);
  const unchanged = target.kind === 'none' ? !current : target.kind === 'existing' && target.projectId === current?.id;
  const detaching = target.kind === 'none' && !!current;
  const apply = async () => {
    if (unchanged) { onClose(); return; }
    if (await bind(target)) onClose();
  };
  // Portalled: the sidebar (a transformed drawer on phones) must not become its containing block.
  return createPortal(
    <div className="ns-backdrop vh-dialog-overlay" onClick={onClose}>
      <div className="ns-card vh-dialog" role="dialog" aria-modal="true" aria-labelledby="ctp-dialog-title" onClick={(e) => e.stopPropagation()}>
        <DialogHead title={c.title} titleId="ctp-dialog-title" description={team.name} onClose={onClose} />
        <label className="ns-label" htmlFor="ctp-project">{c.project}</label>
        <ProjectPicker id="ctp-project" value={target} onChange={setTarget} projects={snap.projects.filter((p) => !p.archivedAt)} newName={team.name} noneLabel={c.none} disabled={busy} />
        <p className="pj-muted mtp-note" role={detaching ? 'alert' : undefined}>{detaching && current ? c.detachBody(current.name) : c.hint}</p>
        <div className="ns-actions vh-dialog-foot">
          <Button variant="ghost" onClick={onClose}>{c.cancel}</Button>
          <Button variant={detaching ? 'danger' : 'primary'} disabled={busy || unchanged} aria-busy={busy || undefined} onClick={() => void apply()}>{detaching ? c.detach : c.apply}</Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
