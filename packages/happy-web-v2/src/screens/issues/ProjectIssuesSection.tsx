/**
 * B-873 (spec §10 项目页): the project's open issues, grouped by status, with a
 * one-line quick add (an unassigned backlog issue in this project). Renders
 * nothing unless the server has Issues on — the project page is unchanged
 * with the switch off.
 */
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { isIssueClosed } from '@slopus/happy-wire';
import { useTranslation } from '@/i18n/useTranslation';
import { toast } from '@/ui';
import { useImeGuard } from '@/utils/ime';
import { createIssue, useIssuesEnabled, useIssuesStore } from '@/sync/issuesStore';
import { useIssuesSync } from '@/sync/issuesSync';
import { useProjects } from '@/sync/projects';
import { groupByStatus, runsOfIssue } from './issuesModel';
import { IssueRow } from './IssuesScreen';
import { useIssuesBase, useMachineNames } from './IssueParts';
import { useIssuesCopy } from './issuesCopy';
import { issueErrorText } from './issueErrors';
import './issues.css';

export function ProjectIssuesSection({ projectId, archived }: { projectId: string; archived: boolean }) {
    const enabled = useIssuesEnabled();
    useIssuesSync(enabled);
    if (!enabled) return null;
    return <Section projectId={projectId} archived={archived} />;
}

function Section({ projectId, archived }: { projectId: string; archived: boolean }) {
    const copy = useIssuesCopy();
    const { lang } = useTranslation();
    const base = useIssuesBase();
    const issues = useIssuesStore((s) => s.issues);
    const runs = useIssuesStore((s) => s.runs);
    const projects = useProjects();
    const machineName = useMachineNames();
    const ime = useImeGuard();
    const [title, setTitle] = useState('');
    const [busy, setBusy] = useState(false);
    const open = useMemo(() => Object.values(issues).filter((i) => i.projectId === projectId && !i.deletedAt && !isIssueClosed(i.status)), [issues, projectId]);
    const groups = groupByStatus(open).filter((g) => g.issues.length > 0);
    const runsBy = useMemo(() => new Map(open.map((i) => [i.id, runsOfIssue(runs, i.id)])), [open, runs]);
    const projectName = (id: string | null) => (id ? projects.projects.find((p) => p.id === id)?.name ?? null : null);
    const add = async () => {
        const text = title.trim();
        if (!text || busy) return;
        setBusy(true);
        try { await createIssue({ title: text, projectId }); setTitle(''); } catch (e) { toast.error(issueErrorText(e, copy)); } finally { setBusy(false); }
    };
    return (
        <section className="pj-section is-project-section" data-testid="project-issues">
            <h2>{copy.projectSection}<span className="pj-count">{open.length}</span>
                <span className="pj-h-actions"><Link className="pj-ghost" to={`${base}/issues?project=${encodeURIComponent(projectId)}`}>{copy.viewAll}</Link></span>
            </h2>
            {!archived && (
                <div className="is-quick-add">
                    <input value={title} placeholder={copy.quickAddPh} aria-label={copy.quickAddPh} disabled={busy} onChange={(e) => setTitle(e.target.value)}
                        onCompositionStart={ime.onCompositionStart} onCompositionEnd={ime.onCompositionEnd}
                        onKeyDown={(e) => { if (ime.isGuarded(e)) return; if (e.key === 'Enter') { e.preventDefault(); void add(); } }} />
                </div>
            )}
            {groups.length === 0 ? <p className="pj-muted">{copy.projectEmpty}</p> : groups.map((g) => (
                <div key={g.status} className="is-group" data-status={g.status}>
                    <div className="is-group-head" role="presentation"><span>{copy.statuses[g.status]}</span><span className="is-count">{g.issues.length}</span></div>
                    <ul className="is-rows">{g.issues.map((issue) => <IssueRow key={issue.id} issue={issue} compact copy={copy} base={base} lang={lang} runsBy={runsBy} machineName={machineName} projectName={projectName} />)}</ul>
                </div>
            ))}
        </section>
    );
}
