import { AgentVersionsSchema, AGENT_VERSION_SOURCES } from '@slopus/happy-wire';

export function readAgentVersions(daemon: unknown, now=Date.now()) {
    if(!daemon || typeof daemon !== 'object') return null;
    const state=daemon as {pid?:unknown;agentVersionEpoch?:unknown;agentVersions?:unknown};
    const parsed=AgentVersionsSchema.safeParse(state.agentVersions);
    if(!parsed.success || parsed.data.daemonPid !== state.pid || typeof state.agentVersionEpoch!=='number') return null;
    const snapshot=parsed.data;
    const stale=now-snapshot.checkedAt>12*60*60*1000 || snapshot.checkedAt>now+60_000
        || snapshot.checkedAt<state.agentVersionEpoch;
    const known=new Set<string>(AGENT_VERSION_SOURCES.map(source=>source.id));
    return {...snapshot,stale,agents:snapshot.agents.filter(agent=>known.has(agent.id))};
}
export function agentUpdateCount(daemon:unknown, now=Date.now()) {
    const snapshot=readAgentVersions(daemon,now);
    return snapshot && !snapshot.stale ? snapshot.agents.filter(agent=>agent.status==='update-available').length : 0;
}
