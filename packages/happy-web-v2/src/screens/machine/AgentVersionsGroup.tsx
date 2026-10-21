import { AGENT_VERSION_SOURCES, isHarnessInstallId, type HarnessInstallId } from '@slopus/happy-wire';
import { ItemGroup, Item, Badge, Button } from '@/ui';
import { useTranslation } from '@/i18n/useTranslation';
import { readAgentVersions } from '@/app/agentVersions';
import { harnessInstallSupported } from '@/app/harnessInstall';
import { useHarnessInstall } from '@/app/useHarnessInstall';

type Agent = { id: string; installed: string | null; latest: string | null; status: string };

/** B-719: Install / Update next to a coding agent this daemon may install. */
function HarnessInstallRow({ machineId, harness, daemon, agent, status, mode, online }: {
    machineId: string; harness: HarnessInstallId; daemon: unknown; agent: Agent; status: string; mode: 'install' | 'update'; online: boolean;
}) {
    const { t } = useTranslation();
    const source = AGENT_VERSION_SOURCES.find((s) => s.id === agent.id)!;
    const action = useHarnessInstall(machineId, harness, daemon, online);
    const versions = mode === 'install' ? '—' : `${agent.installed ?? '—'}${agent.latest ? ` → ${agent.latest}` : ''}`;
    return <Item title={source.label} detail={versions}
        subtitle={action.status ?? <>{mode === 'install' ? t('harnessInstall.notOnMachine') : t('agentUpdates.external')} · <a href={source.docs} target="_blank" rel="noreferrer">{t('agentUpdates.guide')}</a></>}
        right={<>
            <Badge dot={false} tone={mode === 'install' || action.failed ? 'warn' : status === 'update-available' ? 'warn' : 'muted'}>
                {mode === 'install' ? t('harnessInstall.notInstalled') : t(`agentUpdates.${status}` as 'agentUpdates.current')}
            </Badge>
            <Button variant="secondary" loading={action.installing} disabled={action.disabled} onClick={() => void action.start()}>
                {mode === 'install' ? t('harnessInstall.install') : t('harnessInstall.update')}
            </Button>
        </>}/>;
}

export function AgentVersionsGroup({daemon,online,now=Date.now(),machineId,metadata}:{daemon:unknown;online:boolean;now?:number;machineId?:string;metadata?:{harnessInstallVersion?:number}|null}) {
    const {t}=useTranslation();
    const snapshot=readAgentVersions(daemon,now);
    const stale=!online || snapshot?.stale;
    // Listed whenever the daemon supports it; offline rows stay visible but greyed, with the reason.
    const canInstall=!!machineId && harnessInstallSupported(metadata);
    return <ItemGroup title={t('agentUpdates.title')} footer={canInstall ? `${t('agentUpdates.help')} ${t('harnessInstall.help')}` : t('agentUpdates.help')}>
        {!snapshot ? <Item title={t('agentUpdates.notChecked')}/> : <>
            <Item title={t('agentUpdates.checked')} detail={new Date(snapshot.checkedAt).toLocaleString()}
                right={stale ? <Badge dot={false}>{t('agentUpdates.stale')}</Badge> : undefined}/>
            {snapshot.agents.map(agent=>{
                const source=AGENT_VERSION_SOURCES.find(s=>s.id===agent.id)!;
                const status=stale ? 'stale' : ['current','update-available'].includes(agent.status) ? agent.status : 'unknown';
                const installable=canInstall && isHarnessInstallId(agent.id);
                if(agent.status==='not-installed') {
                    // B-719: a missing harness is listed only where it can be installed from here.
                    return installable ? <HarnessInstallRow key={agent.id} machineId={machineId!} harness={agent.id as HarnessInstallId} daemon={daemon} agent={agent} status={status} mode="install" online={online}/> : null;
                }
                if(installable && !stale && agent.status==='update-available') {
                    return <HarnessInstallRow key={agent.id} machineId={machineId!} harness={agent.id as HarnessInstallId} daemon={daemon} agent={agent} status={status} mode="update" online={online}/>;
                }
                return <Item key={agent.id} title={source.label}
                    detail={`${agent.installed ?? '—'}${agent.status==='update-available' && agent.latest ? ` → ${agent.latest}` : ''}`}
                    subtitle={<>{t(agent.id==='claude-sdk' ? 'agentUpdates.bundled' : 'agentUpdates.external')} · <a href={source.docs} target="_blank" rel="noreferrer">{t('agentUpdates.guide')}</a></>}
                    right={<Badge dot={false} tone={status==='update-available'?'warn':'muted'}>{t(`agentUpdates.${status}` as 'agentUpdates.current')}</Badge>}/>;
            })}
        </>}
    </ItemGroup>;
}
