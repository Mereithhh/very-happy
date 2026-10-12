import { useNavigate } from 'react-router-dom';
import { useTranslation } from '@/i18n/useTranslation';
import { useAllMachines } from '@/sync/storage';
import { machineLabel } from '@/utils/machineUtils';
import { formatResetIn, providerLabel, rateLimitTone, tightestRateLimit } from '@/sync/rateLimits';
import { RateLimitBar, useRateLimitClock, useWindowLabel } from './RateLimitMeter';

function shortTime(at: number, now: number): string {
    const d = new Date(at);
    const sameDay = new Date(now).toDateString() === d.toDateString();
    return sameDay
        ? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
        : d.toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' });
}

/**
 * B-555: the tightest subscription window across the account's machines, one
 * row above the sidebar footer. Nothing renders until some CLI has reported.
 */
export function SidebarRateLimit() {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const now = useRateLimitClock();
    const machines = useAllMachines({ includeOffline: true });
    const windowLabel = useWindowLabel();
    const tight = tightestRateLimit(machines, now);
    if (!tight) return null;

    const machine = machines.find((m) => m.id === tight.machineId);
    const label = `${providerLabel(tight.provider)} · ${windowLabel(tight.window)}`;
    const percent = Math.round(tight.window.usedPercent);
    const resetIn = formatResetIn(tight.window.resetsAt, now);
    const meta = tight.stale
        ? t('rateLimits.seenAt', { time: shortTime(tight.window.observedAt, now) })
        : resetIn ?? t('rateLimits.resetUnknown');
    const machineName = machine ? machineLabel(machine) : tight.machineId.slice(0, 8);
    const titleParts = [
        `${label} ${percent}%`,
        resetIn ? t('rateLimits.resetsIn', { time: resetIn }) : t('rateLimits.resetUnknown'),
        t('rateLimits.seenAt', { time: new Date(tight.window.observedAt).toLocaleString() }) + (tight.stale ? ` · ${t('rateLimits.stale')}` : ''),
        machineName,
    ];

    return (
        <button
            type="button"
            className={`sb-ratelimit rl-tone-${rateLimitTone(tight.window.usedPercent)}${tight.stale ? ' is-stale' : ''}`}
            onClick={() => navigate(`/machine/${tight.machineId}`)}
            aria-label={`${t('rateLimits.openMachine', { machine: machineName })}: ${label} ${percent}%`}
            title={titleParts.join('\n')}
        >
            <span className="sb-ratelimit__label">{label}</span>
            <RateLimitBar usedPercent={tight.window.usedPercent} />
            <span className="sb-ratelimit__pct">{percent}%</span>
            <span className="sb-ratelimit__meta">{meta}</span>
        </button>
    );
}
