/**
 * B-878: the owner's "Alice watching" chip in the terminal header — who has
 * this shared terminal open right now. Click opens the share dialog (change
 * tier, revoke). Renders nothing while nobody is watching.
 */
import { useTerminalWatchers } from '@/sync/terminalSharesStore';
import { useTranslation } from '@/i18n/useTranslation';
import './terminalShare.css';

export function TerminalShareWatchers({ machineId, terminalId, onOpen }: { machineId: string; terminalId: string; onOpen: () => void }) {
    const { t } = useTranslation();
    const watchers = useTerminalWatchers(machineId, terminalId);
    if (watchers.length === 0) return null;
    const names = watchers.map((w) => w.displayName).join(', ');
    return (
        <button type="button" className="term-share-watchers" title={t('share.terminal.watchingTitle')} onClick={onOpen}>
            {t('share.terminal.watching', { names })}
        </button>
    );
}
