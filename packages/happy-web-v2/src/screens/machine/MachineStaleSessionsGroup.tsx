/**
 * B-894 — the machine page's「旧版会话」: live sessions still running an older
 * CLI than this daemon, and 「重启空闲的旧会话」 for the checked ones. Rules in
 * app/staleSessionsBatch.ts; the restart is the sessions' own restart-session
 * (restartBrokenSession), one after another, after a confirmation.
 */
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ItemGroup, Item, Badge, Button, Checkbox, toast } from '@/ui';
import { Modal } from '@/modal';
import { useTranslation } from '@/i18n/useTranslation';
import { useAllSessions } from '@/sync/storage';
import { backgroundTaskCount, useHeartbeatLeaseBump } from '@/sync/heartbeatLease';
import { getSessionName } from '@/utils/sessionUtils';
import { readMachineAutoRestart } from '@/app/autoRestartPolicy';
import { batchRestartBlock, batchRestartIds, staleSessionsForMachine, type StaleSessionSkip } from '@/app/staleSessionsBatch';
import { restartIdleStaleSessions, useSessionRestart } from '@/app/sessionRestartAction';
import type { Machine } from '@/sync/storageTypes';

const SKIP_KEY: Record<StaleSessionSkip, 'staleSessions.skipTurnActive' | 'staleSessions.skipPendingRequest' | 'staleSessions.skipBackgroundTasks' | 'staleSessions.skipRestarting'> = {
    'turn-active': 'staleSessions.skipTurnActive',
    'pending-request': 'staleSessions.skipPendingRequest',
    'background-tasks': 'staleSessions.skipBackgroundTasks',
    restarting: 'staleSessions.skipRestarting',
};

export function MachineStaleSessionsGroup({ machine, online }: { machine: Machine; online: boolean }) {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const sessions = useAllSessions();
    const leaseBump = useHeartbeatLeaseBump((s) => s.bump);
    const restartStates = useSessionRestart((s) => s.states);
    const entries = useMemo(() => staleSessionsForMachine(machine.id, machine, sessions, {
        backgroundTasks: (id) => backgroundTaskCount(id),
        autoRestart: readMachineAutoRestart(machine.daemonState),
        restarting: (id) => { const st = restartStates[id]; return !!st && st.phase !== 'failed'; },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }), [machine, sessions, restartStates, leaseBump]);
    // Explicit choices only; anything untouched follows its default (team sessions unchecked).
    const [choices, setChoices] = useState<Record<string, boolean>>({});
    const [running, setRunning] = useState(false);
    const [skipped, setSkipped] = useState<Record<string, StaleSessionSkip>>({});
    if (entries.length === 0) return null;
    const selected = new Set(entries.filter((e) => choices[e.id] ?? e.defaultSelected).map((e) => e.id));
    const ids = batchRestartIds(entries, selected);
    const byId = new Map(sessions.map((s) => [s.id, s]));
    const block = batchRestartBlock({ online, daemonState: machine.daemonState, count: ids.length, running });

    const run = async () => {
        if (block) return;
        const ok = await Modal.confirm(t('staleSessions.confirmTitle', { count: ids.length }), t('staleSessions.confirmBody'), {
            confirmText: t('staleSessions.confirmAction'),
        });
        if (!ok) return;
        setRunning(true);
        try {
            const outcomes = await restartIdleStaleSessions(ids);
            const restarted = outcomes.filter((o) => o.result === 'restarted').length;
            const nowSkipped = Object.fromEntries(outcomes.flatMap((o) => o.result === 'skipped' ? [[o.id, o.reason]] : []));
            const failed = outcomes.filter((o) => o.result === 'failed').length;
            setSkipped(nowSkipped);
            const summary = t('staleSessions.done', { restarted, skipped: Object.keys(nowSkipped).length, failed });
            if (failed > 0) toast.error(summary); else toast.success(summary);
        } finally {
            setRunning(false);
        }
    };

    return (
        <ItemGroup title={t('staleSessions.title', { count: entries.length })} footer={t('staleSessions.footer')}>
            {entries.map((e) => {
                const session = byId.get(e.id);
                const skip = e.skip ?? skipped[e.id] ?? null;
                const subtitle = [
                    t('staleSessions.versions', { from: e.notice.sessionVersion, to: e.notice.machineVersion }),
                    e.team ? t('staleSessions.team') : '',
                    skip ? t(SKIP_KEY[skip]) : '',
                ].filter(Boolean).join(' · ');
                return (
                    <Item
                        key={e.id}
                        // The row opens the session; the box only toggles the selection.
                        left={<span onClick={(ev) => ev.stopPropagation()}><Checkbox
                            checked={e.skip === null && selected.has(e.id)}
                            disabled={e.skip !== null || running}
                            aria-label={t('staleSessions.select', { name: session ? getSessionName(session) : e.id })}
                            onCheckedChange={(checked) => setChoices((c) => ({ ...c, [e.id]: checked }))}
                        /></span>}
                        title={session ? getSessionName(session) : e.id.slice(0, 8)}
                        subtitle={subtitle}
                        right={skip ? <Badge dot={false} tone="muted">{t('staleSessions.skipped')}</Badge>
                            : e.notice.severity === 'critical' ? <Badge dot={false} tone="warn">{t('staleSessions.critical')}</Badge> : undefined}
                        onClick={() => navigate(`/session/${encodeURIComponent(e.id)}`)}
                    />
                );
            })}
            <div className="set-note" style={{ padding: 'var(--sp-2) var(--sp-3) var(--sp-3)' }}>
                <Button variant="secondary" loading={running} disabled={block !== null} onClick={() => void run()}>
                    {t('staleSessions.restartIdle', { count: ids.length })}
                </Button>
                {block === 'needs-cli-upgrade' && <div style={{ marginTop: 'var(--sp-2)' }}>{t('staleSessions.needsCliUpgrade')}</div>}
            </div>
        </ItemGroup>
    );
}
