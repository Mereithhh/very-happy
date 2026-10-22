import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { PROJECT_LIMITS } from '@slopus/happy-wire';
import { Button } from '@/ui';
import { DialogHead } from '@/ui/DialogHead';
import { toast } from '@/ui/Toast';
import { useTranslation } from '@/i18n/useTranslation';
import { useAllMachines, useSetting } from '@/sync/storage';
import { applyLocalMembership, projectsApi, refreshProjects } from '@/sync/projects';
import { machineFsMkdir } from '@/sync/fsOps';
import { isMachineOnline } from '@/utils/machineUtils';
import { withoutTeamWorktrees } from '@/utils/teamWorktree';
import { utf8Bytes } from './projectPage';
import { ProjectFolderPicker } from './ProjectFolderPicker';
import { defaultNewFolder, folderProblem, resolveProjectFolderDraft, type ProjectFolderDraft } from './projectFolderDraft';
import '@/screens/sessions/newsession.css';
import './projects.css';

function copy(zh: boolean) {
  return zh ? {
    title: '新建项目', name: '名称', namePlaceholder: '比如：支付重构', context: '项目说明（context）',
    contextHint: '写下这个项目的目标、约定和背景。项目里的每个会话（包括团队成员）开工时都会先读到它，之后在项目页随时可改。',
    contextPlaceholder: '例如：目标是……；代码在……；约定：……；不要……', optional: '选填',
    create: '创建项目', creating: '正在创建…', cancel: '取消', failed: '创建项目失败',
    exists: '这个目录已经存在，已切换到「选择已有目录」，确认后再创建。', outside: '新目录只能建在 home 下面', mkdirFailed: '新建目录失败', gitFailed: '目录已建好，但 git init 失败',
    done: (n: string) => `已创建项目「${n}」`, tooLong: '超过 8KB 上限',
  } : {
    title: 'New project', name: 'Name', namePlaceholder: 'e.g. Payments revamp', context: 'Project context',
    contextHint: 'The goal, conventions and background of this project. Every session in it — team members too — reads this first; edit it any time on the project page.',
    contextPlaceholder: 'e.g. Goal: …; code lives in …; conventions: …; don’t …', optional: 'Optional',
    create: 'Create project', creating: 'Creating…', cancel: 'Cancel', failed: 'Could not create the project',
    exists: 'That folder already exists — switched to “Choose a folder”; confirm to create.', outside: 'A new folder must be inside home', mkdirFailed: 'Could not create the folder', gitFailed: 'Folder created, but git init failed',
    done: (n: string) => `Created project “${n}”`, tooLong: 'Over the 8 KB limit',
  };
}

/**
 * B-755 (Owner 10-22): 「新建项目」 asks for a name, a folder — an existing one
 * or a new working folder the daemon creates — and an optional but prominent
 * project context (stored as the project's instructions). A project is never
 * created without a folder. Used by the sidebar / ⌘K entry points.
 */
export function NewProjectDialog({ initialName = '', sessionIds = [], onClose }: { initialName?: string; sessionIds?: string[]; onClose: () => void }) {
  const zh = useTranslation().lang.startsWith('zh');
  const c = copy(zh);
  const navigate = useNavigate();
  const machines = useAllMachines({ includeOffline: true });
  const recents = useSetting('recentMachinePaths');
  const nameRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(initialName);
  const [context, setContext] = useState('');
  const [busy, setBusy] = useState(false);
  const [tried, setTried] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [draft, setDraft] = useState<ProjectFolderDraft>(() => {
    const recent = withoutTeamWorktrees(recents ?? []).find((r) => machines.some((m) => m.id === r.machineId && isMachineOnline(m)));
    const machineId = recent?.machineId ?? machines.find(isMachineOnline)?.id ?? machines[0]?.id ?? '';
    return { machineId, mode: 'existing', path: recent?.path ?? '', gitInit: true };
  });
  // The suggested new folder follows the name until the user edits it.
  const [pathTouched, setPathTouched] = useState(false);
  useEffect(() => { nameRef.current?.focus(); }, []);
  useEffect(() => {
    if (draft.mode === 'new' && !pathTouched) setDraft((d) => ({ ...d, path: defaultNewFolder(name) }));
  }, [name, draft.mode, pathTouched]);
  const onFolder = (next: ProjectFolderDraft) => {
    if (next.mode !== draft.mode) { setPathTouched(false); setDraft({ ...next, path: next.mode === 'new' ? defaultNewFolder(name) : '' }); return; }
    if (next.path !== draft.path) setPathTouched(true);
    setDraft(next);
  };
  const machine = machines.find((m) => m.id === draft.machineId);
  const problem = folderProblem(draft, machine, !!machine && isMachineOnline(machine));
  const contextTooLong = utf8Bytes(context) > PROJECT_LIMITS.instructionsBytes;
  const ready = !!name.trim() && !problem && !contextTooLong;
  const submit = async () => {
    setTried(true); setNote(null);
    if (!ready || busy) return;
    setBusy(true);
    try {
      const resolved = await resolveProjectFolderDraft(draft, machine?.metadata?.homeDir, machineFsMkdir);
      if (!resolved.ok) {
        if (resolved.code === 'exists') { setDraft((d) => ({ ...d, mode: 'existing' })); setNote(c.exists); }
        else setNote(resolved.code === 'outside-home' ? c.outside : `${c.mkdirFailed} (${resolved.code})`);
        return;
      }
      if (resolved.git === false) toast.error(c.gitFailed);
      const { project } = await projectsApi.create({
        name: name.trim().slice(0, PROJECT_LIMITS.nameChars),
        folders: [{ ...resolved.folder, primary: true }],
        ...(context.trim() ? { instructions: context.trim() } : {}),
        ...(sessionIds.length ? { sessionIds: sessionIds.slice(0, 200) } : {}),
      });
      if (sessionIds.length) applyLocalMembership(project.id, sessionIds);
      toast.success(c.done(project.name));
      onClose();
      navigate(`/projects/${encodeURIComponent(project.id)}`);
    } catch {
      toast.error(c.failed);
    } finally {
      setBusy(false);
      void refreshProjects();
    }
  };
  return (
    <div className="ns-backdrop vh-dialog-overlay" onClick={onClose}>
      <form className="ns-card vh-dialog pj-new-dialog" role="dialog" aria-modal="true" aria-labelledby="pj-new-title" onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <DialogHead title={c.title} titleId="pj-new-title" onClose={onClose} />
        <label className="ns-label" htmlFor="pj-new-name">{c.name}</label>
        <input id="pj-new-name" ref={nameRef} className="ns-input" value={name} maxLength={PROJECT_LIMITS.nameChars} placeholder={c.namePlaceholder} onChange={(e) => setName(e.target.value)} />
        <ProjectFolderPicker value={draft} onChange={onFolder} zh={zh} showProblem={tried} />
        <div className="pj-new-context">
          <label className="ns-label" htmlFor="pj-new-context">{c.context}<span className="pj-muted"> · {c.optional}</span></label>
          <p className="pj-new-context-hint" id="pj-new-context-hint">{c.contextHint}</p>
          <textarea id="pj-new-context" className="ns-input pj-new-textarea" aria-describedby="pj-new-context-hint" rows={5} value={context} placeholder={c.contextPlaceholder} onChange={(e) => setContext(e.target.value)} />
          {contextTooLong && <p className="pj-folder-problem" role="status">{c.tooLong}</p>}
        </div>
        {note && <p className="pj-folder-problem" role="status">{note}</p>}
        <div className="ns-actions vh-dialog-foot">
          <Button variant="ghost" type="button" onClick={onClose}>{c.cancel}</Button>
          <Button variant="primary" type="submit" disabled={busy || (tried && !ready)} aria-busy={busy || undefined}>{busy ? c.creating : c.create}</Button>
        </div>
      </form>
    </div>
  );
}
