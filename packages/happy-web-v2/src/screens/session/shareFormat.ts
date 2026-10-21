/** B-701 small formatting helpers shared by the share dialog and the settings "Shared" page. */
import type { useTranslation } from '@/i18n/useTranslation';
import type { ShareExpiryDays } from '@/sync/sessionShareTypes';

type T = ReturnType<typeof useTranslation>['t'];
const DAY_MS = 24 * 60 * 60_000;

export function expiryLabel(t: T, days: ShareExpiryDays): string {
    return days === null ? t('share.expiry.never') : t('share.expiry.days', { count: days });
}

/** Whole days left, rounded up; 0 or less = expired. */
export function remainingDays(expiresAt: number, now = Date.now()): number {
    return Math.ceil((expiresAt - now) / DAY_MS);
}

export function remainingDaysLabel(t: T, expiresAt: number, now = Date.now()): string {
    const days = remainingDays(expiresAt, now);
    return days <= 0 ? t('share.expiry.expired') : t('share.expiry.inDays', { count: days });
}

export function formatShareTime(ms: number): string {
    return new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
