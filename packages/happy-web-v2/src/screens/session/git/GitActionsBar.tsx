/**
 * B-583: changes-tab header — branch, ahead count, "Commit…", and a menu with
 * Push / Create PR. Hidden outside a git repo. Commands run in the session
 * cwd through the existing `bash` RPC (any CLI version), so no capability gate.
 */
import { useMemo, useState } from 'react';
import { GitBranch, GitCommitHorizontal, GitPullRequest, MoreHorizontal, Upload } from 'lucide-react';
import { useTranslation } from '@/i18n/useTranslation';
import { ActionDropdownMenu, Button } from '@/ui';
import { commitCandidates } from './gitShell';
import { hostedRepoFor, pushPlan } from './gitFlow';
import { reviewNoun } from './gitRemote';
import { useGitProbe } from './useGitProbe';
import { GitActionDialog, type GitDialogMode } from './GitActionDialog';
import type { GitStatusFiles } from '@/sync/gitStatusFiles';
import './git.css';

export function GitActionsBar({
    sessionId,
    gitStatus,
    active,
    onRefresh,
    onHandedOff,
}: {
    sessionId: string;
    gitStatus: GitStatusFiles | null;
    active: boolean;
    onRefresh: () => void;
    onHandedOff?: () => void;
}) {
    const { lang } = useTranslation();
    const zh = lang.startsWith('zh');
    const { probe, flavor, reload } = useGitProbe(sessionId, active, gitStatus);
    const [dialog, setDialog] = useState<GitDialogMode | null>(null);
    const candidates = useMemo(() => commitCandidates(gitStatus), [gitStatus]);
    if (!probe || !gitStatus) return null;
    const plan = pushPlan(probe);
    const repo = hostedRepoFor(probe);
    const noun = reviewNoun(repo?.provider ?? 'unknown');

    return (
        <div className="gab" role="toolbar" aria-label={zh ? 'Git 操作' : 'Git actions'}>
            <span className="gab-branch" title={probe.upstream ? `${probe.branch ?? 'HEAD'} → ${probe.upstream}` : probe.branch ?? 'HEAD'}>
                <GitBranch size={13} aria-hidden/>
                <span className="gab-name">{probe.branch ?? (zh ? '游离 HEAD' : 'detached')}</span>
                {probe.ahead > 0 && <span className="gab-ahead" aria-label={zh ? `领先 ${probe.ahead} 个提交` : `${probe.ahead} ahead`}>↑{probe.ahead}</span>}
                {probe.behind > 0 && <span className="gab-ahead" aria-label={zh ? `落后 ${probe.behind} 个提交` : `${probe.behind} behind`}>↓{probe.behind}</span>}
                {probe.branch && !probe.upstream && <span className="gab-ahead">{zh ? '未推送' : 'unpushed'}</span>}
            </span>
            <span className="gab-actions">
                <ActionDropdownMenu items={[
                    { key: 'push', label: probe.ahead > 0 ? (zh ? `推送 ↑${probe.ahead}` : `Push ↑${probe.ahead}`) : (zh ? '推送' : 'Push'), icon: Upload, disabled: !plan.needsPush || !plan.remote, onSelect: () => setDialog('push') },
                    { key: 'pr', label: zh ? `创建 ${noun}…` : `Create ${noun}…`, icon: GitPullRequest, disabled: !probe.branch || !plan.remote, onSelect: () => setDialog('pr') },
                ]}>
                    <button type="button" className="fp-icon" aria-label={zh ? '更多 Git 操作' : 'More git actions'} title={zh ? '更多 Git 操作' : 'More git actions'}><MoreHorizontal size={15}/></button>
                </ActionDropdownMenu>
                <Button size="sm" variant="primary" leftIcon={<GitCommitHorizontal size={13}/>} disabled={candidates.length === 0} onClick={() => setDialog('commit')}>
                    {zh ? '提交…' : 'Commit…'}
                </Button>
            </span>
            {dialog && (
                <GitActionDialog sessionId={sessionId} mode={dialog} open onOpenChange={(open) => { if (!open) setDialog(null); }}
                    candidates={candidates} probe={probe} flavor={flavor}
                    onFinished={() => { onRefresh(); void reload(); }} onHandedOff={onHandedOff}/>
            )}
        </div>
    );
}
