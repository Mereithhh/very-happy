/**
 * B-852 — the machine page's「会话自动更新」switch. Rendered only when this
 * daemon run advertises `daemonState.autoRestart` (old CLIs: nothing). Same
 * single-choice idiom as MachineHibernationGroup (Item + Check).
 */
import { useState } from 'react';
import { Check } from 'lucide-react';
import { ItemGroup, Item, toast } from '@/ui';
import { useTranslation } from '@/i18n/useTranslation';
import { machineSetAutoRestart } from '@/sync/ops';
import { readMachineAutoRestart } from '@/app/autoRestartPolicy';
import type { Machine } from '@/sync/storageTypes';

export function MachineAutoRestartGroup({ machine, online }: { machine: Machine; online: boolean }) {
    const { t } = useTranslation();
    const current = readMachineAutoRestart(machine.daemonState);
    const [pending, setPending] = useState<boolean | null>(null);
    if (!current) return null;
    const choose = async (enabled: boolean) => {
        if (pending !== null || enabled === current.enabled) return;
        setPending(enabled);
        try {
            const result = await machineSetAutoRestart(machine.id, enabled);
            if (result.ok) toast.success(t('autoRestart.saved'));
            else toast.error(`${t('autoRestart.saveFailed')}: ${result.error}`);
        } finally {
            setPending(null);
        }
    };
    return (
        <ItemGroup title={t('autoRestart.machineTitle')} footer={t('autoRestart.machineFooter')}>
            {[true, false].map((enabled) => (
                <Item
                    key={String(enabled)}
                    title={t(enabled ? 'autoRestart.on' : 'autoRestart.off')}
                    selected={current.enabled === enabled}
                    right={current.enabled === enabled ? <Check size={16} /> : undefined}
                    loading={pending === enabled}
                    disabled={!online || (pending !== null && pending !== enabled)}
                    onClick={() => void choose(enabled)}
                />
            ))}
        </ItemGroup>
    );
}
