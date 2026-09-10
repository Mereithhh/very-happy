import {it,expect} from 'vitest';
import {readAgentVersions,agentUpdateCount} from './agentVersions';
const now=100_000_000;
const daemon={pid:1,agentVersionEpoch:now-1000,startedAt:now-1000,agentVersions:{daemonPid:1,checkedAt:now,agents:[{id:'codex',installed:'1.0.0',latest:'2.0.0',status:'update-available'}]}};
it('rejects snapshots from another daemon or old/future checks',()=>{
 expect(readAgentVersions({...daemon,pid:2},now)).toBeNull();
 expect(agentUpdateCount(daemon,now+13*60*60*1000)).toBe(0);
 expect(agentUpdateCount(daemon,now-120000)).toBe(0);
 expect(agentUpdateCount(daemon,now)).toBe(1);
});
it('handles old daemons and does not surface arbitrary source IDs',()=>{
 expect(readAgentVersions({},now)).toBeNull();
 expect(readAgentVersions({...daemon,agentVersions:{...daemon.agentVersions,agents:[{...daemon.agentVersions.agents[0],id:'untrusted'}]}},now)?.agents).toEqual([]);
});

it('keeps checks across reconnects but rejects a new daemon epoch',()=>{
 expect(agentUpdateCount({...daemon,startedAt:now+1000},now+1000)).toBe(1);
 expect(agentUpdateCount({...daemon,agentVersionEpoch:now+1000},now+1000)).toBe(0);
});
