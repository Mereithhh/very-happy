/**
 * B-585 WorktreeSetupBanner — strip under the chat header of a session whose
 * worktree the daemon initialized: 「setup 未运行 · 查看并允许」, running,
 * failed, finished. The review dialog shows the FULL script, where it runs and
 * how; approval carries the hash the user saw (the daemon refuses a changed
 * script). Gated on the session's `metadata.worktree` (wrapper) AND the
 * machine's `worktreeVersion` (daemon) — old CLIs render nothing.
 *
 * Token discipline as the other strips (mirror.css): bg ladder, --warn for
 * "needs you", no --accent (setup is not a live signal).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { FileTerminal, X } from 'lucide-react';
import { storage, useSession } from '@/sync/storage';
import { useTranslation } from '@/i18n/useTranslation';
import { Button, Spinner } from '@/ui';
import {
    worktreeSetupApprove, worktreeSetupDecline, worktreeSetupLog, worktreeSetupStatus,
    type WorktreeSetupStatus,
} from '@/sync/worktreeOps';
import { markInvisibleChars, machineSupportsWorktrees, setupBannerKind } from '@/utils/worktree';
import { worktreeCopy } from '@/screens/sessions/worktreeCopy';
import '@/screens/sessions/newsession.css';
import '@/screens/sessions/worktree.css';
import './mirror.css';
import { DialogHead } from '@/ui/DialogHead';

const RUNNING_POLL_MS = 3_000;

type Tracked = Extract<WorktreeSetupStatus, { tracked: true }>;

export function WorktreeSetupBanner({ sessionId }: { sessionId: string }) {
    const { lang } = useTranslation();
    const copy = worktreeCopy(lang);
    const session = useSession(sessionId);
    const machineId = session?.metadata?.machineId;
    const machine = storage((s) => (machineId ? s.machines[machineId] : undefined));
    const worktreeRoot = session?.metadata?.worktree ? (session.metadata.worktree.root || session.metadata.path) : null;
    const enabled = !!machineId && !!worktreeRoot && machineSupportsWorktrees(machine) && !!machine?.active;
    const [status, setStatus] = useState<Tracked | null>(null);
    const [dialog, setDialog] = useState<'review' | 'output' | null>(null);
    const [dismissed, setDismissed] = useState(false);

    const refresh = useCallback(async () => {
        if (!enabled || !machineId || !worktreeRoot) return;
        const result = await worktreeSetupStatus(machineId, worktreeRoot);
        if (result.ok && result.data.tracked) setStatus(result.data);
        else if (result.ok) setStatus(null);
    }, [enabled, machineId, worktreeRoot]);

    useEffect(() => { void refresh(); }, [refresh]);
    const running = status?.setup.state === 'running';
    useEffect(() => {
        if (!running) return;
        const timer = setInterval(() => { void refresh(); }, RUNNING_POLL_MS);
        return () => clearInterval(timer);
    }, [running, refresh]);

    if (!enabled || !status || !machineId) return null;
    const kind = setupBannerKind(status.setup.state);
    const initNote = status.initError ? (
        <div className="mrb-note mrb-note--failed" role="status" data-testid="worktree-init-error">
            <FileTerminal size={13} />
            <span className="mrb-note-text">{copy.initFailed(status.initError)}</span>
        </div>
    ) : null;
    if (!kind) return initNote ? <div className="mrb" data-kind="worktree-init">{initNote}</div> : null;
    if (dismissed && (kind === 'succeeded' || kind === 'declined')) return null;

    const text = kind === 'approve' ? copy.bannerApprove
        : kind === 'running' ? copy.bannerRunning
        : kind === 'failed' ? copy.bannerFailed
        : kind === 'succeeded' ? copy.bannerSucceeded
        : copy.bannerDeclined;
    const action = kind === 'approve' ? copy.bannerApproveAction : kind === 'declined' ? copy.view : copy.viewOutput;
    const openReview = kind === 'approve' || kind === 'declined';

    return (
        <div className="mrb" data-testid="worktree-setup-banner" data-kind={`worktree-setup-${kind}`} data-severity={kind === 'approve' || kind === 'failed' ? 'critical' : undefined}>
            {initNote}
            <div className={`mrb-note${kind === 'failed' ? ' mrb-note--failed' : ''}`} role="status">
                {kind === 'running' ? <Spinner size={13} /> : <FileTerminal size={13} />}
                <span className="mrb-note-text">
                    {text}
                    {status.branch ? <span className="mono"> · {status.branch}</span> : null}
                </span>
                <button type="button" className="mrb-term-btn" onClick={() => setDialog(openReview ? 'review' : 'output')}>
                    <span>{action}</span>
                </button>
                {(kind === 'succeeded' || kind === 'declined') && (
                    <button type="button" className="mrb-dismiss" onClick={() => setDismissed(true)} aria-label={copy.dismiss} title={copy.dismiss}>
                        <X size={13} />
                    </button>
                )}
            </div>
            {dialog && (
                <WorktreeSetupDialog
                    machineId={machineId}
                    worktreePath={status.worktreePath}
                    initial={status}
                    mode={dialog}
                    lang={lang}
                    onClose={() => setDialog(null)}
                    onChanged={(next) => { setStatus(next); if (next.setup.state === 'running') setDialog('output'); }}
                />
            )}
        </div>
    );
}

export function WorktreeSetupDialog({ machineId, worktreePath, initial, mode, lang, onClose, onChanged }: {
    machineId: string;
    worktreePath: string;
    initial: Tracked;
    mode: 'review' | 'output';
    lang: string;
    onClose: () => void;
    onChanged: (status: Tracked) => void;
}) {
    const copy = worktreeCopy(lang);
    const [status, setStatus] = useState<Tracked>(initial);
    const [busy, setBusy] = useState<'approve' | 'decline' | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [output, setOutput] = useState('');
    const offset = useRef(0);
    const cardRef = useRef<HTMLDivElement>(null);

    useEffect(() => { setStatus(initial); }, [initial]);
    // Focus the dialog itself (not a button): Esc works, Enter approves nothing,
    // and a long card is not scrolled to its bottom on open.
    useEffect(() => { cardRef.current?.focus({ preventScroll: true }); }, []);
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [onClose]);

    // Output: pull new bytes until the run is done.
    useEffect(() => {
        if (mode !== 'output') return;
        let cancelled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const pull = async () => {
            const chunk = await worktreeSetupLog(machineId, worktreePath, offset.current);
            if (cancelled) return;
            if (chunk.ok) {
                if (chunk.data.text) setOutput((prev) => (prev + chunk.data.text).slice(-200_000));
                offset.current = chunk.data.offset;
                if (!chunk.data.done) timer = setTimeout(pull, chunk.data.offset < chunk.data.size ? 50 : 1_500);
            }
        };
        void pull();
        return () => { cancelled = true; if (timer) clearTimeout(timer); };
    }, [mode, machineId, worktreePath]);

    const pending = status.pending;
    const invisible = markInvisibleChars(pending?.script ?? '');

    const approve = async () => {
        if (!pending || busy) return;
        setBusy('approve');
        setError(null);
        const result = await worktreeSetupApprove(machineId, worktreePath, pending.hash);
        setBusy(null);
        if (result.ok && result.data.tracked) { onChanged(result.data); return; }
        if (!result.ok && /script-changed/.test(result.error)) {
            const fresh = await worktreeSetupStatus(machineId, worktreePath);
            if (fresh.ok && fresh.data.tracked) { setStatus(fresh.data); onChanged(fresh.data); }
            setError(copy.scriptChanged);
            return;
        }
        setError(`${copy.approveFailed}: ${result.ok ? '' : result.error}`);
    };

    const decline = async () => {
        if (busy) return;
        if (status.setup.state !== 'needs-approval') { onClose(); return; }
        setBusy('decline');
        const result = await worktreeSetupDecline(machineId, worktreePath);
        setBusy(null);
        if (result.ok && result.data.tracked) onChanged(result.data);
        onClose();
    };

    return (
        <div className="ns-backdrop vh-dialog-overlay" onClick={onClose}>
            <div ref={cardRef} tabIndex={-1} className="ns-card wts-card vh-dialog vh-dialog--tall" role="dialog" aria-modal="true" aria-labelledby="wts-title" onClick={(e) => e.stopPropagation()}>
                <DialogHead title={mode === 'review' ? copy.approveTitle : copy.outputTitle} titleId="wts-title" onClose={onClose} />
                {mode === 'review' && pending ? (
                    <>
                        <p className="wts-lead">{copy.approveLead}</p>
                        {pending.changedSinceApproval && <p className="wts-changed" role="note">{copy.changed}</p>}
                        <p className="wts-changed" role="note" data-testid="worktree-repo-files-warning">{copy.repoFilesWarning}</p>
                        {invisible.count > 0 && <p className="wts-changed wts-danger" role="alert" data-testid="worktree-invisible-warning">{copy.invisibleWarning(invisible.count)}</p>}
                        <dl className="wts-facts">
                            <dt>{copy.factRepo}</dt><dd>{pending.repoRoot}</dd>
                            <dt>{copy.factCwd}</dt><dd>{pending.cwd}</dd>
                            <dt>{copy.factRunner}</dt><dd>{pending.runnerLabel}</dd>
                            <dt>{copy.factTimeout}</dt><dd>{copy.minutes(pending.timeoutMinutes)}</dd>
                            <dt>{copy.factConfig}</dt><dd>{pending.configPath}</dd>
                            <dt>{copy.factHash}</dt><dd title={pending.hash}>{pending.hash.slice(0, 12)}</dd>
                        </dl>
                        <pre className="wts-script" data-testid="worktree-setup-script" tabIndex={0}>
                            {invisible.segments.map((seg, i) => seg.kind === 'text'
                                ? <span key={i}>{seg.text}</span>
                                : <mark key={i} className="wts-invisible">{seg.code}</mark>)}
                        </pre>
                        <p className="wts-lead">{copy.autoRunWarning}</p>
                        {status.copied.length > 0 && <div className="wts-state">{copy.copiedFiles(status.copied.length)}: <span className="mono">{status.copied.join(', ')}</span></div>}
                    </>
                ) : mode === 'review' ? (
                    <p className="wts-lead">{copy.stateLabel[status.setup.state] ?? status.setup.state}</p>
                ) : (
                    <>
                        <div className="wts-state">
                            {copy.stateLabel[status.setup.state] ?? status.setup.state}
                            {status.setup.exitCode != null ? ` · ${copy.exitCode(status.setup.exitCode)}` : ''}
                            {status.setup.message ? ` · ${status.setup.message}` : ''}
                        </div>
                        <pre className="wts-script" data-testid="worktree-setup-output" tabIndex={0}>{output || copy.outputEmpty}</pre>
                    </>
                )}
                {error && <p className="wts-error" role="alert">{error}</p>}
                <div className="ns-actions vh-dialog-foot">
                    {mode === 'review' && pending ? (
                        <>
                            <Button variant="ghost" onClick={() => { void decline(); }} disabled={busy !== null}>
                                {copy.decline}
                            </Button>
                            {/* Not the default focus and not bound to Enter: approving code is a deliberate click. */}
                            <Button variant="primary" onClick={() => { void approve(); }} disabled={busy !== null} aria-busy={busy === 'approve' || undefined}>
                                {busy === 'approve' ? <Spinner size={13} /> : null}{copy.allowRun}
                            </Button>
                        </>
                    ) : (
                        <Button variant="ghost" onClick={onClose}>{copy.close}</Button>
                    )}
                </div>
            </div>
        </div>
    );
}
