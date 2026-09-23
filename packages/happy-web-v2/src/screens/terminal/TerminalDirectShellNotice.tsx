import { TriangleAlert, X } from 'lucide-react';
import { useTranslation } from '@/i18n/useTranslation';

/** B-486: install commands shown verbatim (commands are not translated). */
export const TMUX_INSTALL_COMMANDS: ReadonlyArray<{ label: string; command: string }> = [
    { label: 'macOS', command: 'brew install tmux' },
    { label: 'Debian/Ubuntu', command: 'sudo apt install tmux' },
    { label: 'conda', command: 'conda install -c conda-forge tmux' },
];

/**
 * B-486: the open answered WITHOUT a tmux session, so this terminal is a
 * direct shell — it lives only as long as the daemon. Said once per mount,
 * dismissible, never blocking the terminal itself.
 */
export function TerminalDirectShellNotice({ onDismiss }: { onDismiss: () => void }) {
    const { t } = useTranslation();
    return <div className="term-direct-notice" role="note">
        <TriangleAlert size={15} aria-hidden="true" className="term-direct-notice-icon" />
        <div className="term-direct-notice-copy">
            <strong>{t('terminal.directShellTitle')}</strong>
            <p>{t('terminal.directShellHint')}</p>
            <ul className="term-direct-notice-cmds">
                {TMUX_INSTALL_COMMANDS.map((c) => <li key={c.label}><span>{c.label}</span><code className="mono">{c.command}</code></li>)}
            </ul>
        </div>
        <button type="button" className="sb-icon-btn" onClick={onDismiss} title={t('terminal.directShellDismiss')} aria-label={t('terminal.directShellDismiss')}>
            <X size={15} />
        </button>
    </div>;
}
