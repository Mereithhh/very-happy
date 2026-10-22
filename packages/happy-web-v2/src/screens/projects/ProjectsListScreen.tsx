import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, FolderKanban, MoreHorizontal, Plus, Settings2 } from 'lucide-react';
import type { ProjectView } from '@slopus/happy-wire';
import { ActionContextMenu, ActionDropdownMenu } from '@/ui';
import { Modal } from '@/modal';
import { projectsApi, refreshProjects, useProjects } from '@/sync/projects';
import { useBoardItems } from '@/screens/board/useBoardItems';
import { attentionKeysOf } from '@/screens/sessions/sidebarAttention';
import { NewSessionModal } from '@/screens/sessions/NewSessionModal';
import { useTranslation } from '@/i18n/useTranslation';
import { toast } from '@/ui/Toast';
import type { RecentMachinePath } from '@/utils/quickChat';
import { newSessionInProject, projectMenuItems } from './projectActions';
import { projectListModel } from './projectList';
import { projectMenuCopy, projectPath, projectPrimaryFolder, projectSettingsPath } from './projectMenu';
import './projects.css';

/**
 * B-756 `/projects`: every project in one list — the sidebar capability entry
 * 「项目」 lands here. Rows, not cards (design-language 1-Border Rule): name,
 * goal / primary folder, session · team counts and 等你处理; the row opens the
 * project, its ⋯ / right-click menu is the same `buildProjectMenu` as the
 * sidebar group head. Archived projects fold behind 「已归档」.
 */
export function ProjectsListScreen() {
  const { t, lang } = useTranslation();
  const zh = lang.startsWith('zh');
  const navigate = useNavigate();
  const snap = useProjects();
  const boardItems = useBoardItems();
  const attentionKeys = useMemo(() => attentionKeysOf(boardItems), [boardItems]);
  const [archived, setArchived] = useState<ProjectView[] | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [configure, setConfigure] = useState<{ open: boolean; target?: RecentMachinePath }>({ open: false });
  const openConfigure = (target?: RecentMachinePath) => setConfigure({ open: true, target });

  // The shared snapshot lists live projects only; archived ones are read on demand.
  useEffect(() => {
    if (!showArchived) return;
    let cancelled = false;
    projectsApi.list(true).then(({ projects }) => { if (!cancelled) setArchived(projects.filter((p) => p.archivedAt)); }).catch(() => { if (!cancelled) setArchived([]); });
    return () => { cancelled = true; };
  }, [showArchived, snap.projects]);

  const model = useMemo(() => projectListModel(snap.projects, snap.members, attentionKeys), [snap.projects, snap.members, attentionKeys]);
  const archivedModel = useMemo(() => projectListModel(archived ?? [], snap.members, attentionKeys, { archived: true }), [archived, snap.members, attentionKeys]);
  const c = zh
    ? { title: '项目', back: '会话', create: '新建项目', empty: '还没有项目。项目把相关会话、说明和记录放在一起。', unavailable: '这个服务器还不支持项目', loading: '正在加载…', sessions: (n: number) => `${n} 个会话`, teams: (n: number) => `${n} 个团队`, attention: (n: number) => `${n} 个等你处理`, showArchived: '显示已归档', hideArchived: '隐藏已归档', noArchived: '没有已归档的项目', noFolder: '还没有目录' }
    : { title: 'Projects', back: 'Sessions', create: 'New project', empty: 'No projects yet. A project keeps related sessions, instructions and a log together.', unavailable: 'This server does not support projects yet', loading: 'Loading…', sessions: (n: number) => `${n} session${n === 1 ? '' : 's'}`, teams: (n: number) => `${n} team${n === 1 ? '' : 's'}`, attention: (n: number) => `${n} waiting for you`, showArchived: 'Show archived', hideArchived: 'Hide archived', noArchived: 'No archived projects', noFolder: 'No folder yet' };
  const menuCopy = projectMenuCopy(zh);

  const createProject = async () => {
    const name = (await Modal.prompt(t('sidebar.newProject') as string, t('sidebar.newProjectPrompt') as string))?.trim();
    if (!name) return;
    try {
      const { project } = await projectsApi.create({ name: name.slice(0, 120), folders: [] });
      toast.success(t('sidebar.makeProjectDone', { name: project.name }) as string);
      navigate(projectPath(project.id));
    } catch {
      toast.error(t('sidebar.makeProjectFailed') as string);
    } finally {
      void refreshProjects();
    }
  };

  const renderRow = (entry: (typeof model)[number]) => {
    const p = entry.project;
    const items = projectMenuItems(p, { zh, navigate, openConfigure });
    const meta = [c.sessions(entry.sessions), entry.teams ? c.teams(entry.teams) : ''].filter(Boolean).join(' · ');
    const folder = projectPrimaryFolder(p);
    return (
      <ActionContextMenu key={p.id} items={items}>
        <li className={`pjl-row${p.archivedAt ? ' is-archived' : ''}`}>
          <button type="button" className="pjl-main" onClick={() => navigate(projectPath(p.id))}>
            <FolderKanban size={17} aria-hidden className="pjl-icon" />
            <span className="pjl-text">
              <span className="pjl-name">{p.name}</span>
              <span className="pjl-sub">{p.goal || (folder ? folder.path : c.noFolder)}</span>
            </span>
            <span className="pjl-meta">{meta}</span>
            {entry.attention > 0 && <span className="pjl-attn" title={c.attention(entry.attention)} aria-label={c.attention(entry.attention)}>{entry.attention}</span>}
          </button>
          {!p.archivedAt && (
            <button type="button" className="pjl-act" title={menuCopy.newSession} aria-label={`${menuCopy.newSession}: ${p.name}`} onClick={() => newSessionInProject(p, navigate, openConfigure)}><Plus size={16} /></button>
          )}
          <button type="button" className="pjl-act" title={menuCopy.settings} aria-label={`${menuCopy.settings}: ${p.name}`} onClick={() => navigate(projectSettingsPath(p.id))}><Settings2 size={16} /></button>
          <ActionDropdownMenu items={items} align="end" sideOffset={4}>
            <button type="button" className="pjl-act" aria-label={`${menuCopy.actions}: ${p.name}`} title={menuCopy.actions}><MoreHorizontal size={16} /></button>
          </ActionDropdownMenu>
        </li>
      </ActionContextMenu>
    );
  };

  return (
    <main className="pj-screen pjl-screen">
      <header className="pj-head">
        <div className="pj-head-text">
          <Link className="pj-back" to="/"><ArrowLeft size={16} />{c.back}</Link>
          <h1><FolderKanban size={22} aria-hidden />{c.title}</h1>
        </div>
        {snap.status === 'ready' && <button type="button" className="pj-primary pjl-create" onClick={() => void createProject()}><Plus size={14} />{c.create}</button>}
      </header>
      {snap.status === 'unavailable' ? <p className="pj-muted">{c.unavailable}</p>
        : snap.status === 'loading' ? <p className="pj-muted">{c.loading}</p>
        : model.length === 0 ? <p className="pj-muted">{c.empty}</p>
        : <ul className="pjl-list">{model.map(renderRow)}</ul>}
      {snap.status === 'ready' && (
        <section className="pjl-archived">
          <button type="button" className="pj-ghost" aria-expanded={showArchived} onClick={() => setShowArchived((v) => !v)}>{showArchived ? c.hideArchived : c.showArchived}</button>
          {showArchived && (archived === null ? <p className="pj-muted">{c.loading}</p> : archivedModel.length === 0 ? <p className="pj-muted">{c.noArchived}</p> : <ul className="pjl-list">{archivedModel.map(renderRow)}</ul>)}
        </section>
      )}
      {configure.open && <NewSessionModal initialLocation={configure.target} onClose={() => setConfigure({ open: false })} />}
    </main>
  );
}
