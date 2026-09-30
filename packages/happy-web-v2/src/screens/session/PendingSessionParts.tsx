/**
 * B-516: header + body of an optimistic pending session page. The layout
 * slots are SessionDetailScreen's own (single tree), so the composer below
 * stays mounted when the page turns into the real session.
 */
import { useNavigate } from 'react-router-dom';
import { ListEnd, Trash2 } from 'lucide-react';
import { BackButton } from '@/app/BackButton';
import { storage } from '@/sync/storage';
import { Button, Spinner } from '@/ui';
import { useTranslation } from '@/i18n/useTranslation';
import type { PendingSessionRecord } from '@/sync/pendingSessions';
import { pendingSessions, useAdoptableSession } from '@/sync/pendingSessionsRuntime';
import './header.css';
import './input.css';
import './pendingSession.css';

function basename(path: string): string {
    const trimmed = path.replace(/\/+$/, '');
    return trimmed.slice(trimmed.lastIndexOf('/') + 1) || trimmed;
}

export function PendingSessionHeader({ record }: { record: PendingSessionRecord }) {
    const { t } = useTranslation();
    const machineName = storage((s) => {
        const meta = s.machines[record.machineId]?.metadata;
        return meta?.displayName || meta?.host || record.machineId.slice(0, 8);
    });
    const status = record.state === 'failed'
        ? t('pendingSession.sidebarFailed')
        : record.state === 'needs-approval'
            ? t('pendingSession.sidebarNeedsApproval')
            : record.state === 'landed'
                ? t('pendingSession.connecting')
                : t('pendingSession.starting');
    const busy = record.state === 'spawning' || record.state === 'landing' || record.state === 'landed';
    return (
        <header className="ch ps-head" data-pending-state={record.state}>
            <BackButton />
            <div className="ch-main">
                <span className="ch-title">{basename(record.path) || t('newSessionModal.chatTitle')}</span>
                <span className="ps-head-sub mono" title={`${machineName} · ${record.path}`}>{record.agent} · {machineName} · {record.path}</span>
            </div>
            <div className="ch-status ps-head-status" role="status">
                {busy && <Spinner size={14} />}
                <span>{status}</span>
            </div>
        </header>
    );
}

export function PendingSessionBody({ record }: { record: PendingSessionRecord }) {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const adoptable = useAdoptableSession(record);
    const id = record.pendingId;

    if (record.state === 'needs-approval') {
        return (
            <div className="ps-body">
                <section className="ps-card" role="alertdialog" aria-labelledby={`${id}-title`}>
                    <div className="ps-card-title" id={`${id}-title`}>{t('pendingSession.needsApprovalTitle')}</div>
                    <p className="ps-card-text">{t('pendingSession.needsApprovalMessage', { directory: record.approvalDirectory ?? record.path })}</p>
                    <div className="ps-card-actions">
                        <Button variant="ghost" onClick={() => pendingSessions.declineDirectory(id)}>{t('common.cancel')}</Button>
                        <Button variant="primary" onClick={() => pendingSessions.approveDirectory(id)}>{t('pendingSession.createAndStart')}</Button>
                    </div>
                </section>
                <PendingOutbox record={record} />
            </div>
        );
    }

    if (record.state === 'failed') {
        const title = record.failure === 'interrupted'
            ? t('pendingSession.interruptedTitle')
            : record.failure === 'directory-declined'
                ? t('pendingSession.declinedTitle')
                : t('pendingSession.failedTitle');
        const detail = record.failure === 'interrupted' ? t('pendingSession.interruptedMessage') : record.error;
        return (
            <div className="ps-body">
                <section className="ps-card ps-card--failed" role="alert">
                    <div className="ps-card-title">{title}</div>
                    {detail && <p className="ps-card-text ps-card-error">{detail}</p>}
                    <p className="ps-card-text">{t('pendingSession.textKept')}</p>
                    {adoptable && (
                        <div className="ps-adopt">
                            <span>{t('pendingSession.adoptFound')}</span>
                            <Button variant="secondary" onClick={() => pendingSessions.adopt(id, adoptable)}>{t('pendingSession.adopt')}</Button>
                        </div>
                    )}
                    <div className="ps-card-actions">
                        <Button variant="ghost" onClick={() => navigate('/')}>{t('common.back')}</Button>
                        <Button variant="primary" onClick={() => pendingSessions.retry(id)}>{t('common.retry')}</Button>
                    </div>
                </section>
            </div>
        );
    }

    return (
        <div className="ps-body">
            <PendingOutbox record={record} />
        </div>
    );
}

/** Messages sent before the session exists. Same row style as the composer queue. */
function PendingOutbox({ record }: { record: PendingSessionRecord }) {
    const { t } = useTranslation();
    if (record.outbox.length === 0) return null;
    const removable = record.state === 'spawning' || record.state === 'needs-approval';
    return (
        <section className="ci-queue ps-outbox" aria-label={t('pendingSession.outboxTitle')}>
            <div className="ci-queue-list">
                {record.outbox.map((item) => (
                    <div className="ci-queue-item" key={item.id} data-pending-outbox-item>
                        <ListEnd className="ci-queue-index" size={17} aria-hidden />
                        <span className="ps-outbox-text">
                            <span className="ci-queue-text">{item.text}</span>
                            <span className="ps-outbox-hint">{t('pendingSession.sendAfterStart')}</span>
                        </span>
                        <div className="ci-queue-actions">
                            {removable && (
                                <button
                                    type="button"
                                    className="ci-queue-action"
                                    onClick={() => pendingSessions.removeOutboxItem(record.pendingId, item.id)}
                                    aria-label={t('pendingSession.removeQueued')}
                                    title={t('pendingSession.removeQueued')}
                                ><Trash2 size={15} /></button>
                            )}
                        </div>
                    </div>
                ))}
            </div>
        </section>
    );
}
