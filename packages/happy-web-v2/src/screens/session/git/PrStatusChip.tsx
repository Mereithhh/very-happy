/**
 * B-584: PR + CI summary for the session's current branch, in the header.
 *
 * Renders nothing unless `gh pr view` on the machine returned a PR (no gh, not
 * logged in, not GitHub, no PR → silent). Click opens a popover with details
 * and "Ask agent to fix CI" (design-language §6: click → Popover).
 */
import { useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { Bot, CircleCheck, CircleX, ExternalLink, GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft, LoaderCircle, RefreshCw } from 'lucide-react';
import { useSession } from '@/sync/storage';
import { useTranslation } from '@/i18n/useTranslation';
import { Button, Spinner, toast } from '@/ui';
import { restoreToComposer, useHasComposer } from '../composerRestore';
import { shellFlavorFor } from '../diffComments/gitDiff';
import { platformOfSession } from '../diffComments/useGitFileDiff';
import { ciOverall, type PrInfo, type PrState } from './prStatus';
import { refreshPrStatus, usePrLookup, usePrStatusPolling } from './prStatusStore';
import { runLogCommand } from './gitShell';
import { runSync } from './gitRunner';
import { composeCiFixMessage } from './agentHandoff';
import './git.css';

const STATE_ICON: Record<PrState, typeof GitPullRequest> = {
    open: GitPullRequest,
    draft: GitPullRequestDraft,
    merged: GitMerge,
    closed: GitPullRequestClosed,
};

function stateLabel(state: PrState, zh: boolean): string {
    return zh
        ? { open: '打开', draft: '草稿', merged: '已合并', closed: '已关闭' }[state]
        : { open: 'Open', draft: 'Draft', merged: 'Merged', closed: 'Closed' }[state];
}

/** Up to two distinct Actions runs of the failed checks; logs are tail-capped per run. */
async function collectFailureLogs(sessionId: string, pr: PrInfo): Promise<{ runId: string; output: string }[]> {
    const flavor = shellFlavorFor(platformOfSession(sessionId));
    const runIds = [...new Set(pr.failed.map((c) => c.runId).filter((id): id is string => !!id))].slice(0, 2);
    const logs: { runId: string; output: string }[] = [];
    for (const runId of runIds) {
        const cmd = runLogCommand(runId, flavor);
        if (!cmd.ok) continue;
        const res = await runSync(sessionId, cmd.command, 25_000);
        if (res.output.trim() && !/maxBuffer/i.test(res.output)) logs.push({ runId, output: res.output });
    }
    return logs;
}

export function PrStatusChip({ sessionId, compact }: { sessionId: string; compact: boolean }) {
    const { lang } = useTranslation();
    const zh = lang.startsWith('zh');
    const session = useSession(sessionId);
    usePrStatusPolling(sessionId, session?.metadata?.path, session?.active);
    const lookup = usePrLookup(sessionId);
    const hasComposer = useHasComposer(sessionId);
    const [open, setOpen] = useState(false);
    const [fixing, setFixing] = useState(false);
    const [refreshing, setRefreshing] = useState(false);
    if (lookup?.kind !== 'pr') return null;
    const pr = lookup.pr;
    const ci = ciOverall(pr.checks);
    const Icon = STATE_ICON[pr.state];
    const ciText = ci === 'none' ? '' : ci === 'failed' ? `${pr.checks.failed}` : ci === 'pending' ? `${pr.checks.pending}` : `${pr.checks.passed}`;
    const ciWord = zh
        ? { none: '没有 CI 检查', passed: 'CI 通过', failed: 'CI 失败', pending: 'CI 进行中' }[ci]
        : { none: 'No CI checks', passed: 'CI passed', failed: 'CI failed', pending: 'CI running' }[ci];
    const summary = `#${pr.number} · ${stateLabel(pr.state, zh)} · ${ciWord}`;

    const fixCi = async () => {
        setFixing(true);
        try {
            const logs = await collectFailureLogs(sessionId, pr);
            const text = composeCiFixMessage({ pr, failed: pr.failed, logs, lang: zh ? 'zh' : 'en' });
            if (!restoreToComposer(sessionId, text)) {
                toast.show(zh ? '输入框不可用，内容未发送' : 'No composer here; nothing was sent', 'error');
                return;
            }
            toast.show(zh ? '已放入输入框，确认后发送' : 'Added to the composer — review and send', 'success');
            setOpen(false);
        } finally {
            setFixing(false);
        }
    };

    return (
        <Popover.Root open={open} onOpenChange={setOpen}>
            <Popover.Trigger asChild>
                <button type="button" className={`prc prc--${ci}`} aria-label={summary} title={summary}>
                    <Icon size={14} className="prc-state" aria-hidden/>
                    {!compact && <span className="prc-num">#{pr.number}</span>}
                    {ci !== 'none' && (
                        <span className="prc-ci" aria-hidden>
                            {ci === 'failed' ? <CircleX size={13}/> : ci === 'pending' ? <LoaderCircle size={13} className="prc-spin"/> : <CircleCheck size={13}/>}
                            {!compact && <span>{ciText}</span>}
                        </span>
                    )}
                </button>
            </Popover.Trigger>
            <Popover.Portal>
                <Popover.Content className="prc-pop" align="end" sideOffset={6} collisionPadding={12}>
                    <div className="prc-pop-head">
                        <Icon size={15} aria-hidden/>
                        <span className="prc-pop-state">{stateLabel(pr.state, zh)}</span>
                        {pr.url
                            ? <a className="prc-pop-link" href={pr.url} target="_blank" rel="noopener noreferrer">#{pr.number}<ExternalLink size={12} aria-hidden/></a>
                            : <span className="prc-pop-link">#{pr.number}</span>}
                        <button type="button" className="fp-icon prc-refresh" disabled={refreshing}
                            aria-label={zh ? '刷新 PR 状态' : 'Refresh PR status'} title={zh ? '刷新 PR 状态' : 'Refresh PR status'}
                            onClick={() => { setRefreshing(true); void refreshPrStatus(sessionId).finally(() => setRefreshing(false)); }}>
                            <RefreshCw size={13} className={refreshing ? 'fp-spin' : undefined}/>
                        </button>
                    </div>
                    {pr.title && <p className="prc-pop-title">{pr.title}</p>}
                    <p className="prc-pop-ci">
                        {pr.checks.total === 0 ? ciWord : zh
                            ? `检查：${pr.checks.passed} 通过 · ${pr.checks.failed} 失败 · ${pr.checks.pending} 进行中`
                            : `Checks: ${pr.checks.passed} passed · ${pr.checks.failed} failed · ${pr.checks.pending} running`}
                    </p>
                    {pr.failed.length > 0 && (
                        <ul className="prc-pop-failed">
                            {pr.failed.slice(0, 6).map((c, i) => (
                                <li key={`${c.name}-${i}`}>
                                    <CircleX size={12} aria-hidden/>
                                    {c.url ? <a href={c.url} target="_blank" rel="noopener noreferrer">{c.name}</a> : <span>{c.name}</span>}
                                </li>
                            ))}
                            {pr.failed.length > 6 && <li className="prc-more">{zh ? `另外 ${pr.failed.length - 6} 个` : `${pr.failed.length - 6} more`}</li>}
                        </ul>
                    )}
                    {pr.failed.length > 0 && hasComposer && (
                        <div className="prc-pop-actions">
                            <Button size="sm" variant="primary" disabled={fixing} leftIcon={fixing ? <Spinner size={12} color="var(--bg-0)"/> : <Bot size={13}/>} onClick={() => void fixCi()}>
                                {zh ? '让 agent 修 CI' : 'Ask agent to fix CI'}
                            </Button>
                        </div>
                    )}
                </Popover.Content>
            </Popover.Portal>
        </Popover.Root>
    );
}
