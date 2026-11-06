/**
 * B-894 — the machine page's「自动更新 agent」switch (default off) and the last
 * automatic Codex install. Rendered only when this daemon run advertises
 * `daemonState.agentAutoUpdate` (old CLIs: nothing). Same single-choice idiom
 * as MachineAutoRestartGroup.
 */
import { useState } from 'react';
import { Check } from 'lucide-react';
import { ItemGroup, Item, toast } from '@/ui';
import { useTranslation } from '@/i18n/useTranslation';
import { machineSetAgentAutoUpdate } from '@/sync/ops';
import { readMachineAgentAutoUpdate, type AgentAutoUpdateStatus } from '@/app/agentAutoUpdate';
import type { Machine } from '@/sync/storageTypes';

function statusLine(t: ReturnType<typeof useTranslation>['t'], s: AgentAutoUpdateStatus): string {
    const vars = { agent: s.harness === 'codex' ? 'Codex' : s.harness, version: s.target, reason: s.detail ?? 'unknown' };
    if (s.state === 'installing') return t('agentAutoUpdate.installing', vars);
    if (s.state === 'installed') return t('agentAutoUpdate.installed', vars);
    if (s.state === 'gave-up') return t('agentAutoUpdate.gaveUp', vars);
    return t('agentAutoUpdate.failed', vars);
}

export function MachineAgentAutoUpdateGroup({ machine, online }: { machine: Machine; online: boolean }) {
    const { t } = useTranslation();
    const current = readMachineAgentAutoUpdate(machine.daemonState);
    const [pending, setPending] = useState<boolean | null>(null);
    if (!current) return null;
    const choose = async (enabled: boolean) => {
        if (pending !== null || enabled === current.enabled) return;
        setPending(enabled);
        try {
            const result = await machineSetAgentAutoUpdate(machine.id, enabled);
            if (result.ok) toast.success(t('agentAutoUpdate.saved'));
            else toast.error(`${t('agentAutoUpdate.saveFailed')}: ${result.error}`);
        } finally {
            setPending(null);
        }
    };
    const statuses = Object.values(current.status);
    return (
        <ItemGroup title={t('agentAutoUpdate.title')} footer={t('agentAutoUpdate.footer')}>
            {[true, false].map((enabled) => (
                <Item
                    key={String(enabled)}
                    title={t(enabled ? 'agentAutoUpdate.on' : 'agentAutoUpdate.off')}
                    selected={current.enabled === enabled}
                    right={current.enabled === enabled ? <Check size={16} /> : undefined}
                    loading={pending === enabled}
                    disabled={!online || (pending !== null && pending !== enabled)}
                    onClick={() => void choose(enabled)}
                />
            ))}
            {statuses.map((s) => (
                <Item key={s.harness} title={statusLine(t, s)} detail={new Date(s.at).toLocaleString()} />
            ))}
        </ItemGroup>
    );
}
