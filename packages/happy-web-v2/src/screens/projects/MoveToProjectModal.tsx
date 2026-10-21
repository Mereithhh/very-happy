import { reportProjectUx } from '@/sync/projectUx';
import { useState } from 'react';
import { Button } from '@/ui';
import { useTranslation } from '@/i18n/useTranslation';
import { applyLocalMembership, projectsApi, refreshProjects, useProjects } from '@/sync/projects';
import { toast } from '@/ui/Toast';
import { planMove } from './moveToProject';
import { ProjectPicker } from './ProjectPicker';
import '@/screens/sessions/newsession.css';
import './projects.css';

/**
 * B-649 「移到项目…」: pick a project (or 无项目) and, optionally, more sessions
 * from the same group in one go (multi-select). Moving is the only way a
 * session changes project — dragging never does (spec §6.1).
 */
export function MoveToProjectModal({ initialSessionId, candidates, onClose }: {
  initialSessionId: string;
  /** Sessions shown as extra checkboxes (same sidebar group), with titles. */
  candidates: { sessionId: string; title: string }[];
  onClose: () => void;
}) {
  const zh = useTranslation().lang === 'zh-Hans';
  const snap = useProjects();
  const projects = snap.projects.filter((p) => !p.archivedAt);
  const currentMember = snap.members.find((m) => m.sessionId === initialSessionId);
  const current = currentMember?.projectId ?? '';
  const viaTeam = currentMember?.via === 'team';
  const [target, setTarget] = useState<string>(current);
  const [selected, setSelected] = useState<Set<string>>(() => new Set([initialSessionId]));
  const [busy, setBusy] = useState(false);
  const toggle = (id: string) => setSelected((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const apply = async () => {
    const plan = planMove([...selected], target || null, snap.members);
    setBusy(true);
    try {
      if (plan.add) await projectsApi.addMembers(plan.add.projectId, plan.add.sessionIds);
      for (const r of plan.remove) await projectsApi.removeMember(r.projectId, r.sessionId);
      applyLocalMembership(target || null, [...selected]);
      // B-651 ①: a move is a dispatch decision too (entry 'move').
      for (let i = 0; i < selected.size; i++) reportProjectUx({ kind: 'dispatch', entry: 'move', inProject: !!target });
      onClose();
    } catch {
      toast.error(zh ? '移动失败' : 'Could not move');
    } finally {
      setBusy(false);
      void refreshProjects();
    }
  };
  return (
    <div className="ns-backdrop" onClick={onClose}>
      <div className="ns-card" role="dialog" aria-modal="true" aria-label={zh ? '移到项目' : 'Move to project'} onClick={(e) => e.stopPropagation()}>
        <div className="eyebrow">{zh ? '移到项目' : 'Move to project'}</div>
        <label className="ns-label" htmlFor="mtp-project">{zh ? '项目' : 'Project'}</label>
        <ProjectPicker id="mtp-project" value={target ? { kind: 'existing', projectId: target } : { kind: 'none' }} onChange={(next) => setTarget(next.kind === 'existing' ? next.projectId : '')} projects={projects} noneLabel={zh ? '无项目（移出项目）' : 'No project (remove)'} />
        {/* B-726: a team member follows its team — choosing 无项目 cannot take it out (team settings can). */}
        {!target && viaTeam && <p className="pj-muted mtp-note">{zh ? '这个会话因所在团队属于项目；要移出，请在团队设置里修改所属项目。' : 'This session is in the project through its team; change the team’s project in team settings to remove it.'}</p>}
        {candidates.length > 1 && (
          <>
            <label className="ns-label">{zh ? `会话（已选 ${selected.size}）` : `Sessions (${selected.size} selected)`}</label>
            <div className="mtp-list">
              {candidates.map((c) => (
                <label key={c.sessionId} className="mtp-item">
                  <input type="checkbox" checked={selected.has(c.sessionId)} onChange={() => toggle(c.sessionId)} />
                  <span>{c.title}</span>
                </label>
              ))}
            </div>
          </>
        )}
        <div className="ns-actions">
          <Button variant="ghost" onClick={onClose}>{zh ? '取消' : 'Cancel'}</Button>
          <Button variant="primary" disabled={busy || selected.size === 0} aria-busy={busy || undefined} onClick={() => void apply()}>{zh ? '移动' : 'Move'}</Button>
        </div>
      </div>
    </div>
  );
}
