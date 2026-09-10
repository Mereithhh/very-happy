import { AGENT_VERSION_SOURCES } from '@slopus/happy-wire';
import { ItemGroup, Item, Badge } from '@/ui';
import { useTranslation } from '@/i18n/useTranslation';
import { readAgentVersions } from '@/app/agentVersions';

export function AgentVersionsGroup({daemon,online,now=Date.now()}:{daemon:unknown;online:boolean;now?:number}) {
    const {t}=useTranslation();
    const snapshot=readAgentVersions(daemon,now);
    const stale=!online || snapshot?.stale;
    return <ItemGroup title={t('agentUpdates.title')} footer={t('agentUpdates.help')}>
        {!snapshot ? <Item title={t('agentUpdates.notChecked')}/> : <>
            <Item title={t('agentUpdates.checked')} detail={new Date(snapshot.checkedAt).toLocaleString()}
                right={stale ? <Badge dot={false}>{t('agentUpdates.stale')}</Badge> : undefined}/>
            {snapshot.agents.filter(agent=>agent.status!=='not-installed').map(agent=>{
                const source=AGENT_VERSION_SOURCES.find(s=>s.id===agent.id)!;
                const status=stale ? 'stale' : ['current','update-available'].includes(agent.status) ? agent.status : 'unknown';
                return <Item key={agent.id} title={source.label}
                    detail={`${agent.installed ?? '—'}${agent.status==='update-available' && agent.latest ? ` → ${agent.latest}` : ''}`}
                    subtitle={<>{t(agent.id==='claude-sdk' ? 'agentUpdates.bundled' : 'agentUpdates.external')} · <a href={source.docs} target="_blank" rel="noreferrer">{t('agentUpdates.guide')}</a></>}
                    right={<Badge dot={false} tone={status==='update-available'?'warn':'muted'}>{t(`agentUpdates.${status}` as 'agentUpdates.current')}</Badge>}/>;
            })}
        </>}
    </ItemGroup>;
}
