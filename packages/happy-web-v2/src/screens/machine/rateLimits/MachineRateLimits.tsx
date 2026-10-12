import { ItemGroup } from '@/ui';
import { useTranslation } from '@/i18n/useTranslation';
import type { Machine } from '@/sync/storageTypes';
import { isRateLimitStale, providerLabel, readMachineRateLimits } from '@/sync/rateLimits';
import { RateLimitMeter, useRateLimitClock } from './RateLimitMeter';

/**
 * B-555: every rate-limit window this machine last observed, grouped by
 * provider. Renders nothing for an old CLI (no `daemonState.rateLimits`).
 */
export function MachineRateLimits({ machine }: { machine: Pick<Machine, 'daemonState'> }) {
    const { t } = useTranslation();
    const now = useRateLimitClock();
    const providers = readMachineRateLimits(machine, now);
    if (providers.length === 0) return null;
    return (
        <ItemGroup title={t('rateLimits.title')} footer={t('rateLimits.footer')}>
            {providers.map((p) => {
                const stale = isRateLimitStale(p.observedAt, now);
                return (
                    <div key={p.provider} className={`rl-provider${stale ? ' is-stale' : ''}`}>
                        <div className="rl-provider__head">
                            <span className="rl-provider__name">{providerLabel(p.provider)}</span>
                            <span className="rl-provider__seen">
                                {t('rateLimits.seenAt', { time: new Date(p.observedAt).toLocaleString() })}
                                {stale ? ` · ${t('rateLimits.stale')}` : ''}
                            </span>
                        </div>
                        <div className="rl-provider__windows">
                            {p.windows.map((w) => (
                                <RateLimitMeter key={w.kind} window={w} now={now} stale={isRateLimitStale(w.observedAt, now)} />
                            ))}
                        </div>
                    </div>
                );
            })}
        </ItemGroup>
    );
}
