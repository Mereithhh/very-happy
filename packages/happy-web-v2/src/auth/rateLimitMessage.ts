import { t as translate } from '@/text';
import { retryAfterMagnitude } from './rateLimitRetry';

type Translate = typeof translate;

/** B-668: the rate-limit line every sign-in / link form shows. */
export function rateLimitedMessage(t: Translate, retryAfterSeconds: number | undefined): string {
    if (retryAfterSeconds === undefined) return t('signup.errorRateLimited');
    const { unit, count } = retryAfterMagnitude(retryAfterSeconds);
    const wait = unit === 'seconds'
        ? t('signup.retryWaitSeconds', { count })
        : unit === 'minutes'
            ? t('signup.retryWaitMinutes', { count })
            : unit === 'hours'
                ? t('signup.retryWaitHours', { count })
                : t('signup.retryWaitDays', { count });
    return t('signup.errorRateLimitedFor', { wait });
}
