import { StartupLoader } from '@/ui/StartupLoader';
import { LoaderCircle, Unplug, X } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useTranslation } from '@/i18n/useTranslation';
import type { TerminalConnectionNoticeState } from './termConnectionState';

/**
 * The in-pane connection notice: a spinner while waiting, otherwise an unplugged
 * icon, then the title, WHICH machine, what is going on and what one can do.
 * Shared by the owner's terminal and a terminal someone shared with me (B-943).
 *
 * B-950: over a painted terminal (`compact`) it is one row — title · machine and
 * the actions — so the old output stays readable under it; the explanation is
 * kept for screen readers and as the row's tooltip. The row can be folded into a
 * small corner chip; a new notice (another title) unfolds it again.
 */
export function TerminalNoticeView({ waiting, compact, title, machine, detail, actions }: {
    waiting: boolean;
    compact: boolean;
    title: string;
    machine: string;
    detail: string;
    actions?: ReactNode;
}) {
    const { t } = useTranslation();
    const [foldedTitle, setFoldedTitle] = useState<string | null>(null);
    if (compact) {
        const icon = waiting ? <LoaderCircle className="term-connection-spinner" size={16} aria-hidden="true" /> : <Unplug size={16} aria-hidden="true" />;
        if (foldedTitle === title) {
            return <div className="term-connection-notice is-compact is-folded" role="status" aria-live="polite" aria-atomic="true">
                <button type="button" className="term-connection-chip" aria-label={`${title} · ${machine}`} title={`${title} · ${machine}`} aria-expanded={false} onClick={() => setFoldedTitle(null)}>{icon}</button>
            </div>;
        }
        return <div className="term-connection-notice is-compact" role="status" aria-live="polite" aria-atomic="true" title={detail}>
            <div className="term-connection-content">
                {icon}
                <div className="term-connection-copy">
                    <strong>{title}</strong>
                    <span className="mono term-connection-machine">{machine}</span>
                    <span className="term-connection-detail">{detail}</span>
                </div>
                {!waiting && actions && <div className="term-connection-actions">{actions}</div>}
                <button type="button" className="term-connection-fold" aria-label={t('common.close')} title={t('common.close')} aria-expanded onClick={() => setFoldedTitle(title)}><X size={14} aria-hidden="true" /></button>
            </div>
        </div>;
    }
    return <div className="term-connection-notice" role="status" aria-live="polite" aria-atomic="true">
        <div className="term-connection-content">
        {waiting ? <StartupLoader compact showWordmark={false} label={title} className="term-connection-loading" /> : <Unplug size={24} aria-hidden="true" />}
        <div className="term-connection-copy">
            {!waiting && <strong>{title}</strong>}
            <span className="mono term-connection-machine">{machine}</span>
            <p>{detail}</p>
            {!waiting && actions && <div className="term-connection-actions">{actions}</div>}
        </div>
        </div>
    </div>;
}

export function TerminalConnectionNotice({ state, machineName, compact, canRetry, onRetry, onMachine }: {
    state: TerminalConnectionNoticeState;
    machineName: string;
    compact: boolean;
    canRetry: boolean;
    onRetry: () => void;
    onMachine: () => void;
}) {
    const { t } = useTranslation();
    if (!state) return null;
    const waiting = state === 'connecting' || state === 'checking';
    const titles = {
        offline: t('terminal.connectionOffline'), checking: t('terminal.connectionChecking'),
        connecting: t('terminal.connectionOpening'), failed: t('terminal.connectionFailed'),
    };
    const details = {
        offline: t('terminal.connectionOfflineHint'), checking: t('terminal.connectionCheckingHint'),
        connecting: t('terminal.connectionOpeningHint'), failed: t(canRetry ? 'terminal.connectionFailedHint' : 'terminal.connectionCreateUnknown'),
    };
    return <TerminalNoticeView waiting={waiting} compact={compact} title={titles[state]} machine={machineName} detail={details[state]} actions={<>
        {canRetry && state === 'failed' && <button type="button" onClick={onRetry}>{t('terminal.connectionRetry')}</button>}
        <button type="button" onClick={onMachine}>{t('terminal.connectionMachine')}</button>
    </>} />;
}
