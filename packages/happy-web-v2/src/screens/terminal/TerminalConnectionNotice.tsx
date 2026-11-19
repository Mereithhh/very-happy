import { StartupLoader } from '@/ui/StartupLoader';
import { LoaderCircle, Unplug } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from '@/i18n/useTranslation';
import type { TerminalConnectionNoticeState } from './termConnectionState';

/**
 * The in-pane connection notice: a spinner while waiting, otherwise an unplugged
 * icon, then the title, WHICH machine, what is going on and what one can do.
 * Shared by the owner's terminal and a terminal someone shared with me (B-943).
 */
export function TerminalNoticeView({ waiting, compact, title, machine, detail, actions }: {
    waiting: boolean;
    compact: boolean;
    title: string;
    machine: string;
    detail: string;
    actions?: ReactNode;
}) {
    return <div className={`term-connection-notice${compact ? ' is-compact' : ''}`} role="status" aria-live="polite" aria-atomic="true">
        <div className="term-connection-content">
        {waiting && !compact ? <StartupLoader compact showWordmark={false} label={title} className="term-connection-loading" /> : waiting ? <LoaderCircle className="term-connection-spinner" size={24} aria-hidden="true" /> : <Unplug size={24} aria-hidden="true" />}
        <div className="term-connection-copy">
            {(!waiting || compact) && <strong>{title}</strong>}
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
