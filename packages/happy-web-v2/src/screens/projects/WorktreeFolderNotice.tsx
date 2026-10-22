import { useState } from 'react';
import { TriangleAlert } from 'lucide-react';
import type { ProjectDetailResponse } from '@slopus/happy-wire';
import { projectsApi } from '@/sync/projects';
import { useTeamNavigation } from '@/screens/sessions/useTeamNavigation';
import { toast } from '@/ui/Toast';
import { repairWorktreeFolders, worktreeFolders } from './projectPage';
import type { ProjectCopy } from './projectCopy';

/**
 * B-755: a folder that is a team member's throwaway worktree (B-726 projects
 * of teams launched from one) — say so and offer the repository it was cut
 * from. Never changed without this click; an unknown worktree points to settings.
 * Shown on the project page and (B-757) above the settings page's folder list,
 * where「打开设置」is not needed.
 */
export function WorktreeFolderNotice({ detail, c, onChanged, onOpenSettings }: { detail: Pick<ProjectDetailResponse, 'project'>; c: ProjectCopy; onChanged: () => Promise<void>; onOpenSettings?: () => void }) {
  const teams = useTeamNavigation();
  const [busy, setBusy] = useState(false);
  const project = detail.project;
  const bad = worktreeFolders(project.folders, teams);
  if (bad.length === 0) return null;
  const fix = async () => {
    setBusy(true);
    try { await projectsApi.update(project.id, { folders: repairWorktreeFolders(project.folders, teams) }); toast.success(c.worktreeFixed); await onChanged(); }
    catch { toast.error(c.failed); }
    finally { setBusy(false); }
  };
  return (
    <section className="pj-worktree" role="status" data-testid="project-worktree-folder">
      {bad.map((f) => (
        <div key={`${f.machineId}:${f.path}`} className="pj-worktree-row">
          <TriangleAlert size={15} aria-hidden className="pj-worktree-icon" />
          <p>{c.worktreeFolder(f.path)}{f.repository ? c.worktreeRepo(f.repository) : c.worktreeUnknown}</p>
          {f.repository
            ? <button type="button" className="pj-ghost" disabled={busy} aria-busy={busy} onClick={() => void fix()}>{c.worktreeFix}</button>
            : onOpenSettings && <button type="button" className="pj-ghost" onClick={onOpenSettings}>{c.worktreeOpenSettings}</button>}
        </div>
      ))}
    </section>
  );
}
