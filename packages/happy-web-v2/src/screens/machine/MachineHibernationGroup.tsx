/**
 * B-587 — the machine page's「空闲休眠」setting. Rendered only when this
 * daemon run advertises `daemonState.agentHibernation` (old CLIs: nothing).
 * Same single-choice list idiom as the settings pages (Item + Check).
 */
import { useState } from 'react';
import { Check } from 'lucide-react';
import { ItemGroup, Item, toast } from '@/ui';
import { useTranslation } from '@/i18n/useTranslation';
import { machineSetAgentHibernation } from '@/sync/ops';
import { HIBERNATION_IDLE_CHOICES_MS, readMachineHibernation } from '@/app/sessionHibernation';
import type { Machine } from '@/sync/storageTypes';

const HOUR_MS = 60 * 60 * 1000;

function formatCustom(ms: number): string {
    if (ms % HOUR_MS === 0) return `${ms / HOUR_MS}h`;
    if (ms % 60_000 === 0) return `${ms / 60_000}m`;
    return `${Math.round(ms / 1000)}s`;
}

export function MachineHibernationGroup({ machine, online }: { machine: Machine; online: boolean }) {
    const { t } = useTranslation();
    const current = readMachineHibernation(machine.daemonState);
    const [pending, setPending] = useState<number | null>(null);
    if (!current) return null;
    const choices = HIBERNATION_IDLE_CHOICES_MS.includes(current.idleMs)
        ? HIBERNATION_IDLE_CHOICES_MS
        : [...HIBERNATION_IDLE_CHOICES_MS, current.idleMs];
    const label = (ms: number) => ms === 0
        ? t('hibernation.off')
        : ms % HOUR_MS === 0 ? t('hibernation.afterHours', { hours: ms / HOUR_MS }) : t('hibernation.afterCustom', { text: formatCustom(ms) });
    const choose = async (idleMs: number) => {
        if (pending !== null || idleMs === current.idleMs) return;
        setPending(idleMs);
        try {
            const result = await machineSetAgentHibernation(machine.id, idleMs);
            if (result.ok) toast.success(t('hibernation.saved'));
            else toast.error(`${t('hibernation.saveFailed')}: ${result.error}`);
        } finally {
            setPending(null);
        }
    };
    return (
        <ItemGroup title={t('hibernation.machineTitle')} footer={t('hibernation.machineFooter')}>
            {choices.map((ms) => (
                <Item
                    key={ms}
                    title={label(ms)}
                    selected={current.idleMs === ms}
                    right={current.idleMs === ms ? <Check size={16} /> : undefined}
                    loading={pending === ms}
                    disabled={!online || (pending !== null && pending !== ms)}
                    onClick={() => void choose(ms)}
                />
            ))}
        </ItemGroup>
    );
}
