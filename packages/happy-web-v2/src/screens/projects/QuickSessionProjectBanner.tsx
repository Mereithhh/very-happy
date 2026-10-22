import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { FolderKanban, X } from 'lucide-react';
import { useTranslation } from '@/i18n/useTranslation';
import { storage } from '@/sync/storage';
import { applyLocalMembership, projectsApi, refreshProjects, useProjects } from '@/sync/projects';
import { toast } from '@/ui/Toast';
import { MoveToProjectModal } from './MoveToProjectModal';
import { writeDismissed } from './projectSuggestion';
import { clearQuickSession, quickSessionProjectNote } from './newSessionProject';
import './projects.css';

/**
 * B-757: a session made by 快捷新建 (no dialog) says once, at the top, which
 * project it landed in — or that it is in none, with 「加入「X」」 when its
 * folder belongs to X (the B-649/B-755 rule, `suggestProjectFor`) and「加入项目」
 * otherwise. Replaces the plain folder suggestion for that session; closing it
 * also closes that suggestion. Mount only for a quick session, keyed per session.
 */
export function QuickSessionProjectBanner({ sessionId }: { sessionId: string }) {
  const zh = useTranslation().lang.startsWith('zh');
  const snap = useProjects();
  const meta = storage((s) => s.sessions[sessionId]?.metadata as { machineId?: string; path?: string } | undefined);
  const [open, setOpen] = useState(true);
  const [busy, setBusy] = useState(false);
  const [moving, setMoving] = useState(false);
  const note = useMemo(() => quickSessionProjectNote(sessionId, meta, snap), [sessionId, meta, snap]);
  if (!open || !note) return null;
  const close = () => { clearQuickSession(sessionId); writeDismissed(sessionId); setOpen(false); };
  const join = async (projectId: string) => {
    setBusy(true);
    try {
      await projectsApi.addMembers(projectId, [sessionId], 'suggested-accepted');
      applyLocalMembership(projectId, [sessionId]);
    } catch { toast.error(zh ? '加入项目失败' : 'Could not join the project'); }
    finally { setBusy(false); void refreshProjects(); }
  };
  const anyProject = snap.projects.some((p) => !p.archivedAt);
  const text = note.kind === 'member'
    ? (zh ? `这个会话属于项目「${note.project.name}」，会带上项目说明。` : `This session is in “${note.project.name}” and carries its instructions.`)
    : note.kind === 'suggest'
      ? (zh ? `这个会话不属于任何项目，它的目录在「${note.project.name}」里。` : `This session is not in a project; its folder is in “${note.project.name}”.`)
      : (zh ? '这个会话不属于任何项目。' : 'This session is not in any project.');
  return (
    <div className="mrb" data-testid="quick-session-project-banner" data-kind={note.kind}>
      <div className="mrb-note" role="status">
        <FolderKanban size={14} aria-hidden />
        <span className="mrb-note-text">{text}</span>
        {note.kind === 'member' && <Link className="mrb-term-btn" to={`/projects/${encodeURIComponent(note.project.id)}`}>{zh ? '打开项目' : 'Open project'}</Link>}
        {note.kind === 'suggest' && <button type="button" className="mrb-term-btn" disabled={busy} aria-busy={busy} onClick={() => void join(note.project.id)}>{zh ? `加入「${note.project.name}」` : `Join “${note.project.name}”`}</button>}
        {note.kind === 'none' && anyProject && <button type="button" className="mrb-term-btn" onClick={() => setMoving(true)}>{zh ? '加入项目' : 'Join a project'}</button>}
        <button type="button" className="mrb-dismiss" onClick={close} aria-label={zh ? '关闭' : 'Dismiss'} title={zh ? '关闭' : 'Dismiss'}><X size={14} /></button>
      </div>
      {moving && <MoveToProjectModal initialSessionId={sessionId} candidates={[]} onClose={() => setMoving(false)} />}
    </div>
  );
}
