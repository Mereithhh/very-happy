/**
 * B-798 P1-9 — 「会话信息」 from the phone header's ⋯: what the identity
 * popover and the relay badge show on a wide header (agent, machine, path,
 * relay), once those fold away below CHAT_HEADER_IDENTITY_MIN.
 */
import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { MachineRelayStatus } from '@/sync/apiSocket';
import { getServerUrl } from '@/sync/serverConfig';
import { useTranslation } from '@/i18n/useTranslation';
import { relayRegionLabel } from './relayLabel';
import './sessionOptionsDialog.css';

export function SessionInfoDialog({ open, onOpenChange, agent, host, cwd, relay }: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    agent: string;
    host?: string;
    cwd?: string;
    relay: MachineRelayStatus;
}) {
    const { t } = useTranslation();
    const unknown = t('status.unknown');
    return <Dialog.Root open={open} onOpenChange={onOpenChange}>
        <Dialog.Portal><Dialog.Overlay className="vh-dialog-overlay so-overlay" /><Dialog.Content className="vh-dialog so-dialog ch-info-dialog" aria-describedby={undefined}>
            <div className="vh-dialog-head">
                <Dialog.Title className="vh-dialog-title">{t('session.infoTitle')}</Dialog.Title>
                <Dialog.Close asChild><button type="button" className="vh-dialog-close" aria-label={t('common.close')}><X size={18} /></button></Dialog.Close>
            </div>
            <dl className="ch-info-list">
                <dt>{t('session.infoAgent')}</dt><dd>{agent}</dd>
                <dt>{t('session.infoHost')}</dt><dd>{host || unknown}</dd>
                <dt>{t('session.infoPath')}</dt><dd className="mono">{cwd || unknown}</dd>
                <dt>{t('session.chat.relayRegion')}</dt><dd>{relayRegionLabel(relay, getServerUrl())} · {t(`relayBadge.${relay.state}`)}</dd>
            </dl>
        </Dialog.Content></Dialog.Portal>
    </Dialog.Root>;
}
