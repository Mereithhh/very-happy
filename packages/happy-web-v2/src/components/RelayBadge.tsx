import { useEffect, useRef, useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { Radio } from 'lucide-react';
import type { MachineRelayStatus } from '@/sync/apiSocket';
import { getServerUrl } from '@/sync/serverConfig';
import { relayRegionLabel } from '@/screens/session/relayLabel';
import { useTranslation } from '@/i18n/useTranslation';
import './relayBadge.css';

/** Shared by both conversation headers. Hover, keyboard focus and tap reveal
 * the same facts; RTT belongs to the regional browser connection only. */
export function RelayBadge({ status }: { status: MachineRelayStatus }) {
    const { t } = useTranslation();
    const [open, setOpen] = useState(false);
    const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const show = () => { if (closeTimer.current) clearTimeout(closeTimer.current); setOpen(true); };
    const hide = () => {
        if (closeTimer.current) clearTimeout(closeTimer.current);
        closeTimer.current = setTimeout(() => setOpen(false), 150);
    };
    useEffect(() => () => { if (closeTimer.current) clearTimeout(closeTimer.current); }, []);
    const regional = status.transport === 'regional' && status.state === 'connected';
    const label = relayRegionLabel(status, getServerUrl());
    return (
        <Popover.Root open={open} onOpenChange={setOpen}>
            <Popover.Trigger asChild>
                <button type="button" className={`relay-badge is-${status.state}`}
                    aria-label={`${t('session.chat.relayRegion')}: ${label}`}
                    onPointerEnter={(event) => { if (event.pointerType === 'mouse') show(); }} onPointerLeave={(event) => { if (event.pointerType === 'mouse') hide(); }}
                    onFocus={show} onBlur={hide}
                    onClick={(event) => { event.preventDefault(); show(); }}
                >
                    <Radio size={12} aria-hidden />
                    <span>{label}</span>
                </button>
            </Popover.Trigger>
            <Popover.Portal>
                <Popover.Content className="relay-detail" sideOffset={8} collisionPadding={12}
                    onPointerEnter={show} onPointerLeave={hide}
                    onOpenAutoFocus={(event) => event.preventDefault()}
                    onCloseAutoFocus={(event) => event.preventDefault()}
                >
                    <strong>{t('session.chat.relayRegion')}</strong>
                    <dl>
                        <dt>{t('relayBadge.route')}</dt><dd>{regional ? t('relayBadge.regional') : t('relayBadge.control')}</dd>
                        <dt>{t('relayBadge.state')}</dt><dd>{t(`relayBadge.${status.state}`)}</dd>
                        {status.region && <><dt>{t('relayBadge.region')}</dt><dd>{status.region}</dd></>}
                        {status.relayId && <><dt>ID</dt><dd>{status.relayId}</dd></>}
                        <dt>{t('relayBadge.latency')}</dt><dd>{regional && status.rttMs !== undefined ? `${Math.round(status.rttMs)} ms` : '—'}</dd>
                    </dl>
                    <p>{t('relayBadge.latencyHint')}</p>
                </Popover.Content>
            </Popover.Portal>
        </Popover.Root>
    );
}
