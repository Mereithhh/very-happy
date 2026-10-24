/**
 * B-799: the thin top bar — 「已离线，正在重连…」 while the app judges the
 * device offline (sync/networkStatus.ts), 「已恢复」 for a moment after, then
 * it fades out. It takes its own row at the top: the shell moves down by
 * `--net-bar-h` while it shows, so it never covers a page header's buttons.
 */
import { useEffect, useState } from 'react';
import { CloudOff, RefreshCw, Wifi } from 'lucide-react';
import { useTranslation } from '@/i18n/useTranslation';
import { useBannerPhase, type BannerPhase } from '@/sync/networkStatus';
import './networkBanner.css';

/** Fade-out length after 「已恢复」 (matches --dur-base). */
export const NETWORK_BANNER_FADE_MS = 200;

export function NetworkBanner() {
    const { t } = useTranslation();
    const phase = useBannerPhase();
    // The last phase stays on screen while the bar fades out.
    const [shown, setShown] = useState<BannerPhase>(phase);
    const leaving = phase === null && shown !== null;
    useEffect(() => {
        if (phase !== null) {
            setShown(phase);
            return;
        }
        const timer = setTimeout(() => setShown(null), NETWORK_BANNER_FADE_MS);
        return () => clearTimeout(timer);
    }, [phase]);
    useEffect(() => {
        const root = document.documentElement;
        if (shown) root.dataset.netBar = '';
        else delete root.dataset.netBar;
        return () => { delete root.dataset.netBar; };
    }, [shown]);
    if (!shown) return null;
    const Icon = shown === 'offline' ? CloudOff : shown === 'syncing' ? RefreshCw : Wifi;
    const label = shown === 'offline' ? t('network.offline') : shown === 'syncing' ? t('network.syncing') : t('network.recovered');
    return <div className={`net-bar net-bar--${shown}${leaving ? ' is-leaving' : ''}`} role="status" aria-live="polite" data-net-phase={shown}>
        <Icon size={13} aria-hidden />
        <span>{label}</span>
    </div>;
}
