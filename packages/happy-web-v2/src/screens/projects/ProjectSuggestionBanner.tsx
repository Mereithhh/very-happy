import { useMemo, useState } from 'react';
import { FolderKanban, X } from 'lucide-react';
import { useTranslation } from '@/i18n/useTranslation';
import { storage } from '@/sync/storage';
import { applyLocalMembership, projectsApi, refreshProjects, useProjects } from '@/sync/projects';
import { toast } from '@/ui/Toast';
import { readDismissed, suggestProjectFor, writeDismissed } from './projectSuggestion';

/**
 * B-649: 「加入 X 项目？」 for a session whose folder belongs to a project it
 * is not in. Suggestion only — joining is the user's click (spec §1 rule 3).
 * Reuses the session strip chrome (`.mrb-note`). Mount with a per-session key.
 */
export function ProjectSuggestionBanner({ sessionId }: { sessionId: string }) {
  const zh = useTranslation().lang.startsWith('zh');
  const snap = useProjects();
  const meta = storage((s) => s.sessions[sessionId]?.metadata as { machineId?: string; path?: string } | undefined);
  const [dismissed, setDismissed] = useState(() => readDismissed().has(sessionId));
  const [busy, setBusy] = useState(false);
  const isMember = snap.members.some((m) => m.sessionId === sessionId);
  const project = useMemo(
    () => (snap.status === 'ready' && !isMember && meta ? suggestProjectFor(meta, snap.projects) : null),
    [snap.status, snap.projects, isMember, meta],
  );
  if (!project || dismissed) return null;
  const join = async () => {
    setBusy(true);
    try {
      await projectsApi.addMembers(project.id, [sessionId], 'suggested-accepted');
      applyLocalMembership(project.id, [sessionId]);
    } catch { toast.error(zh ? '加入项目失败' : 'Could not join the project'); }
    finally { setBusy(false); void refreshProjects(); }
  };
  const dismiss = () => { writeDismissed(sessionId); setDismissed(true); };
  return (
    <div className="mrb" data-testid="project-suggestion-banner">
      <div className="mrb-note" role="status">
        <FolderKanban size={14} aria-hidden />
        <span className="mrb-note-text">
          {zh ? `这个会话在「${project.name}」项目的目录下，加入项目？加入后下一轮会带上项目说明。` : `This session runs in a folder of "${project.name}". Join the project? Its next turn will carry the project instructions.`}
        </span>
        <button type="button" className="mrb-term-btn" onClick={() => void join()} disabled={busy} aria-busy={busy}>{zh ? '加入' : 'Join'}</button>
        <button type="button" className="mrb-dismiss" onClick={dismiss} aria-label={zh ? '不再提示' : 'Dismiss'} title={zh ? '不再提示' : 'Dismiss'}><X size={14} /></button>
      </div>
    </div>
  );
}
