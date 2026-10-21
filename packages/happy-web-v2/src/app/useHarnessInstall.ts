import { useState } from 'react';
import type { HarnessInstallId } from '@slopus/happy-wire';
import { useTranslation } from '@/i18n/useTranslation';
import { readHarnessInstall, requestHarnessInstall, type HarnessInstallRefusal } from './harnessInstall';

/**
 * B-719: one harness's Install / Update action for one machine — the click,
 * the daemon's published progress and an inline (not toast-only) reason when
 * it was refused or failed.
 */
export function useHarnessInstall(machineId: string | undefined, harness: HarnessInstallId, daemonState: unknown, online = true) {
    const { t } = useTranslation();
    const [sending, setSending] = useState(false);
    const [refused, setRefused] = useState<HarnessInstallRefusal | null>(null);
    const progress = readHarnessInstall(daemonState);
    const mine = progress?.harness === harness ? progress : null;
    const installing = sending || mine?.state === 'installing';
    async function start() {
        if (!machineId || installing || !online) return;
        setSending(true);
        setRefused(null);
        try {
            const result = await requestHarnessInstall(machineId, harness);
            if (!result.ok) setRefused(result);
        } finally {
            setSending(false);
        }
    }
    const status = !online ? t('harnessInstall.offline')
        : refused?.error === 'node_too_old' ? t('harnessInstall.errors.node_too_old', { required: refused.required ?? '?', current: refused.current ?? '?' })
        : refused ? t(`harnessInstall.errors.${refused.error}` as 'harnessInstall.errors.request_failed')
        : mine?.state === 'installing' ? t('harnessInstall.installing')
        : mine?.state === 'installed' ? t('harnessInstall.installed')
        : mine?.state === 'failed' ? t('harnessInstall.failed', { reason: mine.detail ?? 'unknown' })
        : null;
    return { start, installing, status, disabled: !online, failed: !!refused || mine?.state === 'failed' };
}
