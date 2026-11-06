/**
 * B-900 (decision #59) — inside the project share dialog, for ONE person who has the project: give them
 * "can operate" on every terminal in the project RIGHT NOW, or revoke all their terminal access here.
 *
 * Not a project tier: the owner confirms the listed terminals and the server makes one ordinary
 * per-terminal grant each (POST /v1/terminal-shares/batch-operate). A terminal put into the project
 * later stays view only — the dialog then says so (the "gap" hint) and offers the same step for it.
 * The confirmation is the single-terminal one, unchanged: red warning, a required tick, 1/7/30 days,
 * never forever; it is asked once and names the count (and the machines when there are several).
 * Each terminal's result is shown — granted / raised / skipped / failed with the reason — and only
 * the failed ones can be retried. Revoking ends only the direct grants; the project share stays.
 */
import * as Dialog from '@radix-ui/react-dialog';
import { AlertTriangle, SquareTerminal, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Button, Checkbox } from '@/ui';
import { useTranslation } from '@/i18n/useTranslation';
import { useTerminalShares } from '@/sync/terminalSharesStore';
import {
    defaultTerminalShareExpiry,
    directlyGranted,
    failedRefs,
    planProjectOperate,
    type OperatePlanItem,
    type TerminalBatchRef,
    type TerminalBatchResult,
    type TerminalShareExpiry,
} from '@/sync/terminalShareTypes';
import type { TerminalSession } from '@/sync/terminalPushOps';
import { OperatorExpirySelect, OperatorWarning } from '@/screens/session/OperatorGrant';
import { expiryLabel } from '@/screens/session/shareFormat';
import { terminalShareErrorCopy } from '@/screens/terminal/TerminalShareDialog';

type T = ReturnType<typeof useTranslation>['t'];

function stateLabel(t: T, item: OperatePlanItem): string {
    switch (item.current) {
        case 'operator': return t('share.project.stateOperator');
        case 'operatorPending': return t('share.project.stateOperatorPending');
        case 'viewer': return t('share.project.stateViewer');
        default: return t('share.project.stateNone');
    }
}

function resultLabel(t: T, r: TerminalBatchResult): string {
    switch (r.outcome) {
        case 'created': return t('share.project.resultCreated');
        case 'upgraded': return t('share.project.resultUpgraded');
        case 'skipped': return t('share.project.resultSkipped');
        default: return t('share.project.resultFailed', { reason: terminalShareErrorCopy(t, r.code ?? 'unknown') });
    }
}

export function ProjectOperateAll({ terminals, grantee, onPick }: {
    terminals: TerminalSession[];
    grantee: { id: string; displayName: string };
    /** B-899: one terminal → its own share dialog, prefilled. */
    onPick: (term: TerminalSession) => void;
}) {
    const { t } = useTranslation();
    const outgoing = useTerminalShares((s) => s.outgoing);
    const refreshOutgoing = useTerminalShares((s) => s.refreshOutgoing);
    const batchOperate = useTerminalShares((s) => s.batchOperate);
    const batchRevoke = useTerminalShares((s) => s.batchRevoke);
    const [listError, setListError] = useState<string | null>(null);
    const [confirmOpen, setConfirmOpen] = useState(false);
    const [revokeAsk, setRevokeAsk] = useState(false);
    const [revokeBusy, setRevokeBusy] = useState(false);
    const [notice, setNotice] = useState<string | null>(null);

    useEffect(() => { refreshOutgoing().catch((e) => setListError(terminalShareErrorCopy(t, e))); }, [refreshOutgoing, t]);

    const plan = useMemo(() => planProjectOperate(terminals, outgoing ?? [], grantee.id, Date.now()), [terminals, outgoing, grantee.id]);
    const granted = directlyGranted(plan);
    const byKey = new Map(terminals.map((tm) => [`${tm.machineId}:${tm.id}`, tm]));

    const revokeAll = async () => {
        if (revokeBusy) return;
        setRevokeBusy(true); setNotice(null);
        try {
            const n = await batchRevoke({ accountId: grantee.id, terminals: granted });
            setNotice(t('share.project.revokeAllDone', { count: n }));
            setRevokeAsk(false);
        } catch (e) { setNotice(terminalShareErrorCopy(t, e)); }
        finally { setRevokeBusy(false); }
    };

    if (terminals.length === 0) return <p className="shd-grant-terms-hint">{t('share.project.noOwnTerminals')}</p>;
    return (
        <div className="pjo" data-testid="project-operate-all" data-confirm-open={confirmOpen || undefined}>
            {plan.gap.length > 0 && (
                <p className="pjo-gap" role="note"><AlertTriangle size={14} aria-hidden />{t('share.project.gapHint', { name: grantee.displayName, count: plan.gap.length })}</p>
            )}
            <div className="pjo-actions">
                {outgoing === undefined ? <span className="shd-grant-terms-hint">{listError ?? t('common.loading')}</span>
                    : plan.send.length > 0
                        ? <Button type="button" variant="danger" size="sm" onClick={() => setConfirmOpen(true)}>{t('share.project.operateAll', { count: plan.send.length })}</Button>
                        : <span className="shd-grant-terms-hint">{t('share.project.operateAllDone')}</span>}
                {granted.length > 0 && !revokeAsk && <Button type="button" variant="ghost" size="sm" onClick={() => { setRevokeAsk(true); setNotice(null); }}>{t('share.project.revokeAll')}</Button>}
            </div>
            {revokeAsk && (
                <div className="shd-grant shd-grant--confirm" role="group" aria-label={t('share.project.revokeAll')}>
                    <span className="shd-grant-text"><span className="shd-grant-name">{t('share.project.revokeAllConfirm', { name: grantee.displayName, count: granted.length })}</span></span>
                    <Button type="button" variant="ghost" size="sm" onClick={() => setRevokeAsk(false)}>{t('common.cancel')}</Button>
                    <Button type="button" variant="danger" size="sm" loading={revokeBusy} onClick={() => void revokeAll()}>{t('share.dialog.revoke')}</Button>
                </div>
            )}
            {notice && <p className="shd-grant-terms-hint" role="status">{notice}</p>}
            <p className="shd-grant-terms-hint">{t('share.project.operateTerminalsHint')} {t('share.project.operateAllScope')}</p>
            {plan.items.map((item) => {
                const tm = byKey.get(`${item.machineId}:${item.terminalId}`)!;
                return (
                    <button key={`${item.machineId}:${item.terminalId}`} type="button" className="shd-grant-term pjo-term" data-state={item.current} onClick={() => onPick(tm)}>
                        <SquareTerminal size={14} aria-hidden /><span className="pjo-term-title">{item.title}</span><span className="pjo-term-machine">{item.machineName}</span>
                        <span className="pjo-state">{stateLabel(t, item)}</span>
                    </button>
                );
            })}
            {confirmOpen && <OperateAllConfirm grantee={grantee} plan={plan} onClose={() => setConfirmOpen(false)} batchOperate={batchOperate} />}
        </div>
    );
}

function OperateAllConfirm({ grantee, plan, onClose, batchOperate }: {
    grantee: { id: string; displayName: string };
    plan: ReturnType<typeof planProjectOperate>;
    onClose: () => void;
    batchOperate: ReturnType<typeof useTerminalShares.getState>['batchOperate'];
}) {
    const { t } = useTranslation();
    // Frozen at open: the owner confirms exactly this list; a terminal joining meanwhile is not added.
    const [items] = useState(plan.items);
    const [sent] = useState<TerminalBatchRef[]>(plan.send);
    const [machines] = useState(plan.machines);
    const [expiry, setExpiry] = useState<TerminalShareExpiry>(defaultTerminalShareExpiry('operator'));
    const [ack, setAck] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [results, setResults] = useState<TerminalBatchResult[] | null>(null);
    const count = plan.send.length;

    const run = async (refs: TerminalBatchRef[]) => {
        if (busy || !ack || refs.length === 0) return;
        setBusy(true); setError(null);
        try {
            const out = await batchOperate({ accountId: grantee.id, terminals: refs, expiresInDays: expiry, confirmOperator: true });
            // A retry replaces only the retried rows; earlier successes stay listed.
            setResults((prev) => {
                const next = new Map((prev ?? []).map((r) => [`${r.machineId}:${r.terminalId}`, r]));
                for (const r of out) next.set(`${r.machineId}:${r.terminalId}`, r);
                return [...next.values()];
            });
        } catch (e) { setError(terminalShareErrorCopy(t, e)); }
        finally { setBusy(false); }
    };
    const retry = results ? failedRefs(results, sent) : [];
    const resultOf = new Map((results ?? []).map((r) => [`${r.machineId}:${r.terminalId}`, r]));

    return (
        <Dialog.Root open onOpenChange={(next) => { if (!next && !busy) onClose(); }}>
            <Dialog.Portal>
                <Dialog.Overlay className="vh-dialog-overlay so-overlay" />
                <Dialog.Content className="vh-dialog so-dialog shd-opconfirm" role="alertdialog" aria-describedby={undefined} data-testid="project-operate-confirm">
                    <div className="vh-dialog-head so-head">
                        <Dialog.Title className="vh-dialog-title so-title">{results ? t('share.project.resultTitle') : t('share.project.confirmTitle', { name: grantee.displayName, count })}</Dialog.Title>
                        <Dialog.Close className="vh-dialog-close so-close" aria-label={t('common.close')} disabled={busy}><X size={18} /></Dialog.Close>
                    </div>
                    <ul className="pjo-list" aria-label={t('share.project.terminals')}>
                        {items.map((item) => {
                            const key = `${item.machineId}:${item.terminalId}`;
                            const r = resultOf.get(key);
                            return (
                                <li key={key} className="pjo-item" data-outcome={r?.outcome ?? item.action}>
                                    <SquareTerminal size={14} aria-hidden />
                                    <span className="pjo-item-title">{item.title}</span>
                                    <span className="pjo-item-machine">{item.machineName}</span>
                                    <span className="pjo-item-state">{r ? resultLabel(t, r) : stateLabel(t, item)}</span>
                                </li>
                            );
                        })}
                    </ul>
                    {!results && <>
                        <ul className="shd-opconfirm-facts">
                            <li>{t('share.operator.confirmWho', { name: grantee.displayName })}</li>
                            <li>{t('share.project.confirmCount', { count })}</li>
                            {machines.length > 1 ? <li>{t('share.project.confirmMachines', { machines: machines.join('、') })}</li>
                                : machines[0] ? <li>{t('share.operator.confirmMachine', { host: machines[0] })}</li> : null}
                            <li className="shd-opconfirm-expiry">
                                <span id="pjo-exp">{t('share.expiry.label')}</span>
                                <OperatorExpirySelect labelledBy="pjo-exp" value={expiry} onChange={setExpiry} />
                            </li>
                            <li className="pjo-muted">{t('share.project.operateAllScope')}</li>
                            <li className="pjo-muted">{t('share.project.confirmAccept')}</li>
                        </ul>
                        <OperatorWarning compact manyMachines={machines.length > 1} />
                        <Checkbox className="shd-opack" checked={ack} onCheckedChange={setAck}>{t(machines.length > 1 ? 'share.operator.acknowledgeMany' : 'share.operator.acknowledge')}</Checkbox>
                    </>}
                    {results && <p className="pjo-muted">{t('share.operator.confirmExpiry', { expiry: expiryLabel(t, expiry) })} · {t('share.project.confirmAccept')}</p>}
                    {error && <p className="shd-error" role="alert">{error}</p>}
                    <div className="vh-dialog-foot">
                        {results ? <>
                            {retry.length > 0 && <Button type="button" variant="danger" size="md" loading={busy} onClick={() => void run(retry)}>{t('share.project.retryFailed', { count: retry.length })}</Button>}
                            <Button type="button" variant="secondary" size="md" disabled={busy} onClick={onClose}>{t('common.close')}</Button>
                        </> : <>
                            <Button type="button" variant="ghost" size="md" disabled={busy} onClick={onClose}>{t('common.cancel')}</Button>
                            <Button type="button" variant="danger" size="md" loading={busy} disabled={!ack} onClick={() => void run(sent)}>{t('share.operator.confirmGrant')}</Button>
                        </>}
                    </div>
                </Dialog.Content>
            </Dialog.Portal>
        </Dialog.Root>
    );
}
