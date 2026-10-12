import { useEffect, useState } from 'react';
import { useTranslation } from '@/i18n/useTranslation';
import {
    barPercent,
    fallbackWindowLabel,
    formatResetIn,
    isKnownRateLimitKind,
    rateLimitTone,
    type RateLimitWindow,
} from '@/sync/rateLimits';
import './rateLimits.css';

/** Re-render on a slow tick; countdowns are minute-grained, never per second. */
export function useRateLimitClock(intervalMs = 30_000): number {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
        return () => window.clearInterval(timer);
    }, [intervalMs]);
    return now;
}

export function useWindowLabel(): (window: Pick<RateLimitWindow, 'kind' | 'windowMinutes'>) => string {
    const { t } = useTranslation();
    return (window) => isKnownRateLimitKind(window.kind)
        ? t(`rateLimits.windows.${window.kind}`)
        : fallbackWindowLabel(window);
}

/** Thin usage bar; colour carries warn/danger only (never the live accent). */
export function RateLimitBar({ usedPercent }: { usedPercent: number }) {
    return (
        <span className={`rl-bar rl-tone-${rateLimitTone(usedPercent)}`} aria-hidden="true">
            <span className="rl-bar__fill" style={{ width: `${barPercent(usedPercent)}%` }} />
        </span>
    );
}

/** One window: label · bar · percent · reset countdown (machine page row). */
export function RateLimitMeter({ window, now, stale }: { window: RateLimitWindow; now: number; stale: boolean }) {
    const { t } = useTranslation();
    const label = useWindowLabel()(window);
    const resetIn = formatResetIn(window.resetsAt, now);
    const percent = Math.round(window.usedPercent);
    return (
        <div className={`rl-meter${stale ? ' is-stale' : ''}`} role="group" aria-label={`${label} ${percent}%`}>
            <div className="rl-meter__head">
                <span className="rl-meter__label">{label}</span>
                <span className={`rl-meter__pct rl-tone-${rateLimitTone(window.usedPercent)}`}>{percent}%</span>
            </div>
            <RateLimitBar usedPercent={window.usedPercent} />
            <div className="rl-meter__meta">
                {resetIn ? t('rateLimits.resetsIn', { time: resetIn }) : t('rateLimits.resetUnknown')}
            </div>
        </div>
    );
}
