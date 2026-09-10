import { StartupLoader } from '@/ui/StartupLoader';
import { LoaderCircle, Unplug } from 'lucide-react';
import { useTranslation } from '@/i18n/useTranslation';
import type { TerminalConnectionNoticeState } from './termConnectionState';

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
    return <div className={`term-connection-notice${compact ? ' is-compact' : ''}`} role="status" aria-live="polite" aria-atomic="true">
        <div className="term-connection-content">
        {waiting && !compact ? <StartupLoader compact showWordmark={false} label={titles[state]} className="term-connection-loading" /> : waiting ? <LoaderCircle className="term-connection-spinner" size={24} aria-hidden="true" /> : <Unplug size={24} aria-hidden="true" />}
        <div className="term-connection-copy">
            {(!waiting || compact) && <strong>{titles[state]}</strong>}
            <span className="mono term-connection-machine">{machineName}</span>
            <p>{details[state]}</p>
            {!waiting && <div className="term-connection-actions">
                {canRetry && state === 'failed' && <button type="button" onClick={onRetry}>{t('terminal.connectionRetry')}</button>}
                <button type="button" onClick={onMachine}>{t('terminal.connectionMachine')}</button>
            </div>}
        </div>
        </div>
    </div>;
}
