/**
 * B-583: commit / push / open-PR dialog for the session's working directory.
 *
 * One Radix dialog with three modes. Every command goes through gitRunner
 * (session `bash` RPC, cwd = metadata.path); commit/push/`gh pr create` run as
 * polled background jobs on POSIX so a slow pre-commit hook never hits the
 * 30s RPC cap. No force push exists anywhere in this flow; pushing the
 * default branch (or main/master) needs an explicit second step.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Bot, ChevronRight, ExternalLink, X } from 'lucide-react';
import { useTranslation } from '@/i18n/useTranslation';
import { Button, CopyButton, Spinner, toast } from '@/ui';
import { Checkbox } from '@/ui/Checkbox';
import { useDelayedFlag } from '@/ui/useDelayedFlag';
import type { ShellFlavor } from '../diffComments/gitDiff';
import { restoreToComposer, useHasComposer } from '../composerRestore';
import { buildCommitCommand, buildPrCreateCommand, buildPushCommand, GH_AUTH_STATUS_COMMAND, humanCommand, isAuthFailure, type CommitCandidate, type GitProbe } from './gitShell';
import { compareUrl, reviewNoun } from './gitRemote';
import { buildFailureText, createdPrUrl, hostedRepoFor, outputTail, parseCommitSummary, pushPlan, remoteHeadBranch } from './gitFlow';
import { runJob, runSync, type RunResult } from './gitRunner';
import { composeFixFailureMessage, composeSyncRemoteMessage, composeWriteCommitMessage, type FailedStage } from './agentHandoff';
import { refreshPrStatus } from './prStatusStore';
import '../sessionOptionsDialog.css';
import './git.css';

export type GitDialogMode = 'commit' | 'push' | 'pr';

type Step = { stage: FailedStage; command: string; result: RunResult };
type Phase =
    | { kind: 'edit' }
    | { kind: 'confirm-push' }
    | { kind: 'running'; stage: FailedStage }
    | { kind: 'done'; steps: Step[] };

const PUSH_AFTER_STORAGE = 'vh-git-push-after';

/** Same status badges as the changes list (files.css). */
const STATUS_CLASS: Record<CommitCandidate['status'], string> = {
    modified: 'fp-st--mod',
    added: 'fp-st--add',
    deleted: 'fp-st--del',
    renamed: 'fp-st--ren',
    untracked: 'fp-st--unt',
};

function readPushAfter(): boolean {
    try { return localStorage.getItem(PUSH_AFTER_STORAGE) === '1'; } catch { return false; }
}
function writePushAfter(value: boolean) {
    try { localStorage.setItem(PUSH_AFTER_STORAGE, value ? '1' : '0'); } catch { /* per-viewer convenience only */ }
}

function splitMessage(message: string): { title: string; body: string } {
    const text = message.replace(/\r\n?/g, '\n').trim();
    const nl = text.indexOf('\n');
    return nl === -1 ? { title: text, body: '' } : { title: text.slice(0, nl).trim(), body: text.slice(nl + 1).trim() };
}

export function GitActionDialog({
    sessionId,
    mode: initialMode,
    open,
    onOpenChange,
    candidates,
    probe,
    flavor,
    onFinished,
    onHandedOff,
}: {
    sessionId: string;
    mode: GitDialogMode;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    candidates: CommitCandidate[];
    probe: GitProbe;
    flavor: ShellFlavor | null;
    /** refresh the changes list + branch info after any command ran */
    onFinished: () => void;
    /** text went to the composer (narrow layouts close the panel) */
    onHandedOff?: () => void;
}) {
    const { lang } = useTranslation();
    const zh = lang.startsWith('zh');
    const hasComposer = useHasComposer(sessionId);
    const titleRef = useRef<HTMLHeadingElement>(null);
    const [mode, setMode] = useState<GitDialogMode>(initialMode);
    const [phase, setPhase] = useState<Phase>({ kind: 'edit' });
    const [selected, setSelected] = useState<Set<string>>(() => new Set(candidates.map((c) => c.path)));
    const [message, setMessage] = useState('');
    const [pushAfter, setPushAfter] = useState(readPushAfter);
    const [prTitle, setPrTitle] = useState('');
    const [prBody, setPrBody] = useState('');
    const [draft, setDraft] = useState(false);
    const [gh, setGh] = useState<'checking' | 'ok' | 'missing'>('checking');
    const [buildError, setBuildError] = useState<string | null>(null);
    const abort = useRef<AbortController | null>(null);

    const repo = useMemo(() => hostedRepoFor(probe), [probe]);
    const plan = useMemo(() => pushPlan(probe), [probe]);
    const noun = reviewNoun(repo?.provider ?? 'unknown');
    /** a push may run: there is a target and the same-named upstream is not ahead of us */
    const canPush = !!plan.pushTarget && !plan.remoteAhead;

    // Fresh state each time the dialog opens; stop polling when it closes
    // (the job itself still finishes on the machine).
    useEffect(() => {
        if (!open) { abort.current?.abort(); return; }
        abort.current = new AbortController();
        setMode(initialMode);
        setPhase({ kind: 'edit' });
        setSelected(new Set(candidates.map((c) => c.path)));
        setMessage('');
        setBuildError(null);
        const last = splitMessage(probe.lastCommitMessage);
        setPrTitle(last.title);
        setPrBody(last.body);
        setDraft(false);
        return () => abort.current?.abort();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open]);

    useEffect(() => {
        if (!open || mode !== 'pr') return;
        if (repo?.provider !== 'github') { setGh('missing'); return; }
        let live = true;
        setGh('checking');
        void runSync(sessionId, GH_AUTH_STATUS_COMMAND, 15_000).then((r) => { if (live) setGh(r.ok ? 'ok' : 'missing'); });
        return () => { live = false; };
    }, [open, mode, repo?.provider, sessionId]);

    const running = phase.kind === 'running';
    const showSpinner = useDelayedFlag(running);
    const allSelected = candidates.length > 0 && candidates.every((c) => selected.has(c.path));
    const chosen = candidates.filter((c) => selected.has(c.path));

    const handOff = (text: string) => {
        if (!restoreToComposer(sessionId, text)) {
            toast.show(zh ? '输入框不可用，内容未发送' : 'No composer here; nothing was sent', 'error');
            return;
        }
        toast.show(zh ? '已放入输入框，确认后发送' : 'Added to the composer — review and send', 'success');
        onOpenChange(false);
        onHandedOff?.();
    };

    const runStep = async (stage: FailedStage, command: string): Promise<Step> => {
        setPhase({ kind: 'running', stage });
        const result = await runJob(sessionId, command, flavor, abort.current?.signal);
        return { stage, command, result };
    };

    const finish = (steps: Step[]) => {
        if (abort.current?.signal.aborted) return;
        setPhase({ kind: 'done', steps });
        onFinished();
        void refreshPrStatus(sessionId);
    };

    const doPush = async (steps: Step[]) => {
        const cmd = buildPushCommand({ target: plan.pushTarget, flavor });
        if (!cmd.ok) { setBuildError(buildFailureText(cmd.reason, zh)); return null; }
        const step = await runStep('push', cmd.command);
        steps.push(step);
        return step;
    };

    const doCommit = async (alsoPush: boolean) => {
        setBuildError(null);
        const cmd = buildCommitCommand({ files: chosen, all: allSelected, message, flavor });
        if (!cmd.ok) { setBuildError(buildFailureText(cmd.reason, zh)); setPhase({ kind: 'edit' }); return; }
        const steps: Step[] = [];
        const commit = await runStep('commit', cmd.command);
        steps.push(commit);
        if (commit.result.ok && alsoPush) await doPush(steps);
        finish(steps);
    };

    const submitCommit = () => {
        if (running || chosen.length === 0 || !message.trim()) return;
        writePushAfter(pushAfter);
        if (pushAfter && canPush && plan.protectedBranch) { setPhase({ kind: 'confirm-push' }); return; }
        void doCommit(pushAfter && canPush);
    };

    const submitPush = async () => {
        if (running) return;
        setBuildError(null);
        const steps: Step[] = [];
        await doPush(steps);
        finish(steps);
    };

    const submitPr = async () => {
        if (running) return;
        setBuildError(null);
        const cmd = buildPrCreateCommand({ title: prTitle, body: prBody, draft, flavor });
        if (!cmd.ok) { setBuildError(buildFailureText(cmd.reason, zh)); return; }
        const steps: Step[] = [];
        if (plan.needsPush) {
            const push = await doPush(steps);
            if (!push || !push.result.ok) { finish(steps); return; }
        }
        steps.push(await runStep('pr', cmd.command));
        finish(steps);
    };

    const branchLine = probe.branch
        ? `${probe.branch}${plan.target ? ` → ${plan.target}` : ''}`
        : (zh ? '游离 HEAD' : 'detached HEAD');
    const title = mode === 'commit' ? (zh ? '提交改动' : 'Commit changes')
        : mode === 'push' ? (zh ? '推送' : 'Push')
        : (zh ? `创建 ${noun}` : `Create ${noun}`);

    const stageText = (stage: FailedStage) => zh
        ? { commit: '正在提交…', push: '正在推送…', pr: `正在创建 ${noun}…` }[stage]
        : { commit: 'Committing…', push: 'Pushing…', pr: `Creating ${noun}…` }[stage];

    const divergent = plan.pushTarget?.divergentUpstream;
    const divergentNote = divergent && plan.target && (zh
        ? `上游是 ${divergent}，与本地分支名不同：将推送到 ${plan.target}（新分支）并设为上游，不会推到 ${divergent}。`
        : `The upstream is ${divergent}, which has a different name: this pushes to ${plan.target} (new branch) and makes it the upstream; ${divergent} is not touched.`);
    const remoteAheadNote = plan.remoteAhead && (zh
        ? `${plan.target} 有 ${probe.behind} 个本地没有的新提交。先拉取（或让 agent 处理）再推送。`
        : `${plan.target} has ${probe.behind} commit${probe.behind === 1 ? '' : 's'} you don't have. Pull first (or ask the agent), then push.`);
    const syncButton = plan.remoteAhead && hasComposer && plan.target && (
        <button type="button" className="gd-link" disabled={running}
            onClick={() => handOff(composeSyncRemoteMessage({ target: plan.target!, behind: probe.behind, lang: zh ? 'zh' : 'en' }))}>
            <Bot size={14}/>{zh ? '让 agent 拉取并推送' : 'Ask the agent to pull and push'}
        </button>
    );
    const commitPreview = buildCommitCommand({ files: chosen, all: allSelected, message: message || 'x', flavor });
    const protectedNote = zh
        ? `当前在 ${probe.branch}（默认分支），推送会直接更新 ${plan.target ?? '远端'}。`
        : `You are on ${probe.branch} (the default branch); pushing updates ${plan.target ?? 'the remote'} directly.`;

    // ── bodies ────────────────────────────────────────────────────────────

    const commitBody = (
        <>
            <fieldset className="gd-files" disabled={running}>
                <legend className="gd-sr">{zh ? '要提交的文件' : 'Files to commit'}</legend>
                <label className="gd-file gd-file--all">
                    <Checkbox checked={allSelected} indeterminate={!allSelected && chosen.length > 0}
                        onChange={() => setSelected(allSelected ? new Set() : new Set(candidates.map((c) => c.path)))}/>
                    <span>{zh ? `全部 ${candidates.length} 个文件` : `All ${candidates.length} files`}</span>
                    {!allSelected && <span className="gd-count">{zh ? `已选 ${chosen.length}` : `${chosen.length} selected`}</span>}
                </label>
                <div className="gd-file-list">
                    {candidates.map((c) => (
                        <label key={c.path} className="gd-file" title={c.oldPath ? `${c.oldPath} → ${c.path}` : c.path}>
                            <Checkbox checked={selected.has(c.path)} onChange={() => setSelected((prev) => {
                                const next = new Set(prev);
                                if (next.has(c.path)) next.delete(c.path); else next.add(c.path);
                                return next;
                            })}/>
                            <span className={`fp-status ${STATUS_CLASS[c.status]}`}>{c.status[0].toUpperCase()}</span>
                            <span className="gd-path">{c.path}</span>
                        </label>
                    ))}
                </div>
            </fieldset>
            <label className="so-field">
                <span className="so-field-label">{zh ? '提交信息' : 'Commit message'}</span>
                <textarea className="gd-input gd-textarea" value={message} disabled={running} rows={3}
                    placeholder={zh ? '第一行是标题，空一行后写正文' : 'Subject on the first line, body after a blank line'}
                    onChange={(e) => setMessage(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submitCommit(); } }}/>
            </label>
            <label className="gd-check">
                <Checkbox checked={pushAfter && canPush} disabled={running || !canPush} onCheckedChange={setPushAfter}/>
                <span>{zh ? '提交后推送' : 'Push after commit'}{plan.target && <span className="gd-mono"> · {plan.target}</span>}</span>
            </label>
            {!plan.remote && <p className="so-description">{buildFailureText('no-remote', zh)}</p>}
            {pushAfter && canPush && divergentNote && <p className="so-description">{divergentNote}</p>}
            {remoteAheadNote && <p className="gd-warn">{remoteAheadNote}</p>}
            {commitPreview.ok && commitPreview.allFallback && <p className="gd-warn">{zh
                ? '文件太多，超出 Windows 命令长度：将改用 git add -A，会包含打开对话框后新出现的改动。'
                : 'Too many files for a Windows command line: falls back to git add -A, which also includes changes made after this dialog opened.'}</p>}
            {hasComposer && (
                <button type="button" className="gd-link" disabled={running || chosen.length === 0}
                    onClick={() => handOff(composeWriteCommitMessage({ files: chosen.map((c) => c.path), all: allSelected, push: pushAfter && canPush, lang: zh ? 'zh' : 'en' }))}>
                    <Bot size={14}/>{zh ? '让 agent 写提交信息并提交' : 'Let the agent write the message and commit'}
                </button>
            )}
        </>
    );

    const pushBody = (
        <div className="gd-summary">
            <p>{plan.needsPush
                ? (zh ? `把 ${probe.branch} 推送到 ${plan.target ?? (plan.remote ? `${plan.remote}（新分支）` : '远端')}${probe.ahead > 0 ? `，${probe.ahead} 个提交` : ''}。` : `Push ${probe.branch} to ${plan.target ?? plan.remote ?? 'the remote'}${probe.ahead > 0 ? ` (${probe.ahead} commit${probe.ahead === 1 ? '' : 's'})` : ''}.`)
                : (zh ? '远端已是最新，没有要推送的提交。' : 'The remote is up to date; nothing to push.')}</p>
            {divergentNote && plan.needsPush && <p className="so-description">{divergentNote}</p>}
            {plan.protectedBranch && plan.needsPush && !plan.remoteAhead && <p className="gd-warn">{protectedNote}</p>}
            {remoteAheadNote && <p className="gd-warn">{remoteAheadNote}</p>}
            {syncButton}
            {!plan.remote && <p className="so-description">{buildFailureText('no-remote', zh)}</p>}
        </div>
    );

    const head = remoteHeadBranch(probe);
    const compare = repo && head && !plan.protectedBranch ? compareUrl(repo, plan.defaultBranch, head) : null;
    const pushCmd = buildPushCommand({ target: plan.pushTarget, flavor: flavor ?? 'posix' });
    const ghCmd = buildPrCreateCommand({ title: prTitle || 'title', body: prBody, draft, flavor: flavor ?? 'posix' });
    const canCreate = repo?.provider === 'github' && gh === 'ok' && !!probe.branch && !plan.protectedBranch && !!prTitle.trim() && !(plan.needsPush && !canPush);
    const prBody_ = (
        <>
            {mode === 'pr' && gh === 'checking' && repo?.provider === 'github' && <p className="gd-stage" role="status"><Spinner size={12}/>{zh ? '检查执行电脑上的 gh…' : 'Checking gh on the machine…'}</p>}
            {plan.needsPush && remoteAheadNote && <p className="gd-warn">{remoteAheadNote}</p>}
            {plan.needsPush && syncButton}
            {plan.protectedBranch && <p className="gd-warn">{zh ? `当前在默认分支 ${probe.branch}，先切到新分支再创建 ${noun}。` : `You are on the default branch ${probe.branch}; switch to a new branch before creating a ${noun}.`}</p>}
            {repo?.provider === 'github' && gh === 'ok' ? (
                <>
                    <label className="so-field">
                        <span className="so-field-label">{zh ? '标题' : 'Title'}</span>
                        <input className="gd-input" value={prTitle} disabled={running} onChange={(e) => setPrTitle(e.target.value)}/>
                    </label>
                    <label className="so-field">
                        <span className="so-field-label">{zh ? '正文' : 'Description'}</span>
                        <textarea className="gd-input gd-textarea" value={prBody} disabled={running} rows={4} onChange={(e) => setPrBody(e.target.value)}/>
                    </label>
                    <label className="gd-check">
                        <Checkbox checked={draft} disabled={running} onCheckedChange={setDraft}/>
                        <span>{zh ? '草稿' : 'Draft'}</span>
                    </label>
                    {plan.needsPush && !plan.protectedBranch && canPush && <p className="so-description">{divergentNote || (zh ? `会先把 ${probe.branch} 推送到 ${plan.target ?? '远端'}。` : `${probe.branch} is pushed to ${plan.target ?? 'the remote'} first.`)}</p>}
                </>
            ) : gh !== 'checking' || repo?.provider !== 'github' ? (
                <div className="gd-summary">
                    <p>{repo?.provider === 'github'
                        ? (zh ? '执行电脑上没有可用的 gh（未安装或未登录）。在 GitHub 页面创建，或把命令复制到终端。' : 'gh is not available on the machine (not installed or not logged in). Create it on GitHub, or copy the command to a terminal.')
                        : repo && repo.provider !== 'unknown'
                            ? (zh ? `在 ${repo.provider === 'gitlab' ? 'GitLab' : 'Bitbucket'} 页面创建 ${noun}。` : `Create the ${noun} on ${repo.provider === 'gitlab' ? 'GitLab' : 'Bitbucket'}.`)
                            : (zh ? '无法识别远端托管平台，推送后在托管平台上创建。' : 'The remote host is not recognised; push, then create it on the hosting site.')}</p>
                    {plan.needsPush && pushCmd.ok && <div className="gd-cmd"><code>{humanCommand(pushCmd.command)}</code><CopyButton text={humanCommand(pushCmd.command)} label={zh ? '复制推送命令' : 'Copy push command'}/></div>}
                    {repo?.provider === 'github' && ghCmd.ok && <div className="gd-cmd"><code>{humanCommand(ghCmd.command)}</code><CopyButton text={humanCommand(ghCmd.command)} label={zh ? '复制 gh 命令' : 'Copy gh command'}/></div>}
                    {compare && <a className="vh-btn vh-btn--secondary vh-btn--sm gd-ext" href={compare} target="_blank" rel="noopener noreferrer"><ExternalLink size={13}/>{zh ? `打开 ${noun} 创建页` : `Open the ${noun} page`}</a>}
                </div>
            ) : null}
        </>
    );

    const doneBody = phase.kind === 'done' && (
        <div className="gd-results">
            {phase.steps.map((step, i) => <StepResult key={i} step={step} zh={zh} noun={noun} hasComposer={hasComposer} onFix={() => handOff(composeFixFailureMessage({ stage: step.stage, command: step.command, exitCode: step.result.exitCode, output: step.result.output, lang: zh ? 'zh' : 'en' }))}/>)}
            {phase.steps.length === 0 && buildError && <p className="gd-error" role="alert">{buildError}</p>}
        </div>
    );

    // ── actions ───────────────────────────────────────────────────────────

    const cancel = <Dialog.Close asChild><button type="button" className="vh-modal-btn is-cancel">{phase.kind === 'done' ? (zh ? '关闭' : 'Close') : (zh ? '取消' : 'Cancel')}</button></Dialog.Close>;
    const primary = (label: string, onClick: () => void, disabled: boolean) => (
        <button type="button" className="vh-modal-btn is-primary gd-primary" disabled={disabled || running} aria-busy={running} onClick={onClick}>
            {running && showSpinner ? <Spinner size={12} color="var(--bg-0)"/> : null}
            <span>{label}</span>
        </button>
    );
    const doneOk = phase.kind === 'done' && phase.steps.length > 0 && phase.steps.every((s) => s.result.ok);
    const committedAndPushed = doneOk && phase.kind === 'done' && phase.steps.some((s) => s.stage === 'push');

    let actions: ReactNode;
    if (phase.kind === 'confirm-push') {
        actions = <>
            <button type="button" className="vh-modal-btn is-cancel" onClick={() => setPhase({ kind: 'edit' })}>{zh ? '返回' : 'Back'}</button>
            <button type="button" className="vh-modal-btn is-cancel" onClick={() => void doCommit(false)}>{zh ? '只提交' : 'Commit only'}</button>
            <button type="button" className="vh-modal-btn is-primary" onClick={() => void doCommit(true)}>{zh ? '仍然推送' : 'Push anyway'}</button>
        </>;
    } else if (phase.kind === 'done') {
        const commitFailed = mode === 'commit' && phase.steps.some((s) => s.stage === 'commit' && !s.result.ok);
        actions = <>
            {commitFailed && <button type="button" className="vh-modal-btn is-cancel" onClick={() => setPhase({ kind: 'edit' })}>{zh ? '返回修改' : 'Back to edit'}</button>}
            {cancel}
            {(mode === 'commit' || mode === 'push') && doneOk && (committedAndPushed || mode === 'push') && repo && !plan.protectedBranch && (
                <button type="button" className="vh-modal-btn is-primary" onClick={() => {
                    // The probe may predate the commit we just made: default the PR to that commit's message.
                    const committed = phase.steps.some((s) => s.stage === 'commit' && s.result.ok);
                    const src = splitMessage(committed ? message : probe.lastCommitMessage);
                    setPrTitle(src.title);
                    setPrBody(src.body);
                    setMode('pr');
                    setPhase({ kind: 'edit' });
                }}>{zh ? `创建 ${noun}…` : `Create ${noun}…`}</button>
            )}
        </>;
    } else if (mode === 'commit') {
        actions = <>{cancel}{primary(pushAfter && canPush ? (zh ? '提交并推送' : 'Commit & push') : (zh ? '提交' : 'Commit'), submitCommit, chosen.length === 0 || !message.trim())}</>;
    } else if (mode === 'push') {
        actions = <>{cancel}{primary(plan.protectedBranch ? (zh ? '仍然推送' : 'Push anyway') : (zh ? '推送' : 'Push'), () => void submitPush(), !plan.needsPush || !canPush)}</>;
    } else {
        actions = <>{cancel}{canCreate && primary(plan.needsPush ? (zh ? `推送并创建 ${noun}` : `Push & create ${noun}`) : (zh ? `创建 ${noun}` : `Create ${noun}`), () => void submitPr(), !canCreate)}</>;
    }

    return (
        <Dialog.Root open={open} onOpenChange={(next) => { if (!next) abort.current?.abort(); onOpenChange(next); }}>
            <Dialog.Portal>
                <Dialog.Overlay className="vh-dialog-overlay so-overlay"/>
                <Dialog.Content className="vh-dialog so-dialog gd" aria-describedby={undefined}
                    onOpenAutoFocus={(e) => { e.preventDefault(); titleRef.current?.focus(); }}>
                    <div className="vh-dialog-head so-head">
                        <div>
                            <Dialog.Title ref={titleRef} tabIndex={-1} className="vh-dialog-title so-title">{title}</Dialog.Title>
                            <p className="gd-branch" title={branchLine}>{branchLine}</p>
                        </div>
                        <Dialog.Close asChild><button type="button" className="vh-dialog-close so-close" aria-label={zh ? '关闭' : 'Close'}><X size={18}/></button></Dialog.Close>
                    </div>
                    <div className="gd-body">
                        {phase.kind === 'confirm-push' ? <p className="gd-warn">{protectedNote}</p>
                            : phase.kind === 'done' ? doneBody
                            : mode === 'commit' ? commitBody : mode === 'push' ? pushBody : prBody_}
                        {phase.kind !== 'done' && buildError && <p className="gd-error" role="alert">{buildError}</p>}
                    </div>
                    <div className="vh-dialog-foot gd-actions">
                        <span className="vh-dialog-foot-note gd-stage" role="status">{running && showSpinner ? stageText(phase.stage) : ''}</span>
                        {actions}
                    </div>
                </Dialog.Content>
            </Dialog.Portal>
        </Dialog.Root>
    );
}

function StepResult({ step, zh, noun, hasComposer, onFix }: { step: Step; zh: boolean; noun: string; hasComposer: boolean; onFix: () => void }) {
    const [expanded, setExpanded] = useState(false);
    const { result } = step;
    if (result.ok) {
        if (step.stage === 'commit') {
            const s = parseCommitSummary(result.output);
            return <p className="gd-ok">{zh ? '已提交' : 'Committed'}{s && <> <span className="gd-mono">{s.sha.slice(0, 7)}</span> {s.subject}</>}</p>;
        }
        if (step.stage === 'push') return <p className="gd-ok">{zh ? '已推送' : 'Pushed'}</p>;
        const url = createdPrUrl(result.output);
        return <p className="gd-ok">{zh ? `已创建 ${noun}` : `${noun} created`}{url && <> · <a href={url} target="_blank" rel="noopener noreferrer" className="gd-a">{url.replace(/^https:\/\//, '')}</a></>}</p>;
    }
    if (result.stillRunning || result.timedOut) {
        return <p className="gd-warn" role="alert">{zh
            ? '命令没有在限定时间内结束（或已失去跟踪），可能仍在运行。去终端用 git status / git log -1 确认结果。'
            : 'The command did not finish in time (or was lost track of) and may still be running. Check with git status / git log -1 in a terminal.'}</p>;
    }
    const label = zh
        ? { commit: '提交失败', push: '推送失败', pr: `创建 ${noun} 失败` }[step.stage]
        : { commit: 'Commit failed', push: 'Push failed', pr: `${noun} creation failed` }[step.stage];
    const tail = outputTail(result.output);
    return (
        <div className="gd-fail" role="alert">
            <p className="gd-fail-title">{label}{result.exitCode !== null && <span className="gd-mono"> · exit {result.exitCode}</span>}</p>
            {step.stage === 'push' && isAuthFailure(result.output) && <p className="gd-warn">{zh
                ? '需要在终端完成认证（SSH 密钥口令、host key 或凭据），完成后再推送。'
                : 'Authentication has to be completed in a terminal (SSH passphrase, host key or credentials); push again afterwards.'}</p>}
            {!expanded && tail && <pre className="gd-pre">{tail}</pre>}
            {expanded && <pre className="gd-pre gd-pre--full">{result.output}{result.truncated ? (zh ? '\n…（只保留最后 64KB）' : '\n…(last 64KB only)') : ''}</pre>}
            <div className="gd-fail-actions">
                {result.output.trim() && (
                    <button type="button" className="gd-link" aria-expanded={expanded} onClick={() => setExpanded((v) => !v)}>
                        <ChevronRight size={13} className={`tg-chevron${expanded ? ' is-open' : ''}`}/>{expanded ? (zh ? '收起' : 'Collapse') : (zh ? '展开全文' : 'Show full output')}
                    </button>
                )}
                <span className="gd-fail-spacer"/>
                {result.output.trim() && <CopyButton text={result.output} showLabel label={zh ? '复制输出' : 'Copy output'}/>}
                {hasComposer && <Button size="sm" variant="primary" leftIcon={<Bot size={13}/>} onClick={onFix}>{zh ? '让 agent 修复' : 'Ask agent to fix'}</Button>}
            </div>
        </div>
    );
}
