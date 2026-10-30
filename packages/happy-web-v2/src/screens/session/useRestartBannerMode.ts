/**
 * B-852 — whether a restart banner (StaleWrapperBanner / ModelSupportBanner)
 * still needs a human for this session, from the machine's
 * `daemonState.autoRestart`. Rules: app/autoRestartPolicy.ts.
 */
import { useEffect, useState } from 'react';
import { storage, useSession } from '@/sync/storage';
import type { useTranslation } from '@/i18n/useTranslation';
import {
    failureSummary,
    readMachineAutoRestart,
    restartBannerMode,
    waitReasonKey,
    type AutoRestartWaitReason,
    type RestartBannerMode,
} from '@/app/autoRestartPolicy';

/** Re-evaluate once a minute: "waiting for an hour" turns true without any new daemon write. */
function useMinuteClock(): number {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        const timer = window.setInterval(() => setNow(Date.now()), 60_000);
        return () => window.clearInterval(timer);
    }, []);
    return now;
}

export function useRestartBannerMode(sessionId: string, missing: 'grace' | 'manual' = 'grace'): RestartBannerMode {
    const session = useSession(sessionId);
    const daemonState = storage((s) => {
        const id = session?.metadata?.machineId;
        return id ? s.machines[id]?.daemonState : undefined;
    });
    const now = useMinuteClock();
    return restartBannerMode(sessionId, readMachineAutoRestart(daemonState), now, missing);
}

type T = ReturnType<typeof useTranslation>['t'];

const WHY_KEY = {
    'turn-active': 'autoRestart.whyTurnActive',
    'pending-request': 'autoRestart.whyPendingRequest',
    'queued-input': 'autoRestart.whyQueuedInput',
    'background-tasks': 'autoRestart.whyBackgroundTasks',
    'scheduled-wakeup': 'autoRestart.whyScheduledWakeup',
    'recent-activity': 'autoRestart.whyRecentActivity',
    'automation-running': 'autoRestart.whyAutomationRunning',
    other: 'autoRestart.whyOther',
} as const satisfies Record<AutoRestartWaitReason, string>;

/** The banner text for a `waiting` / `failed` mode; null for the others (they keep their own wording). */
export function autoRestartBannerText(
    mode: RestartBannerMode,
    behind: { sessionVersion: string; machineVersion: string } | { agent: string },
    t: T,
): string | null {
    if (mode.kind === 'failed') return t('autoRestart.failed', { reason: failureSummary(mode.reason) || '?' });
    if (mode.kind !== 'waiting') return null;
    const why = t(WHY_KEY[waitReasonKey(mode.reason)]);
    return 'agent' in behind ? t('autoRestart.waitingAgent', { agent: behind.agent, why }) : t('autoRestart.waiting', { ...behind, why });
}
