import {it,expect,vi} from 'vitest';
const rpc=vi.hoisted(()=>vi.fn());
vi.mock('@/sync/apiSocket',()=>({apiSocket:{sessionRPC:rpc}}));
import {claudeRuntimeRequest,isRuntimeStatus,runtimeOutcome} from './claudeRuntimeControl';
it('surfaces resolved RPC errors instead of treating them as operation success',async()=>{
 rpc.mockResolvedValueOnce({error:'permission_pending'});
 await expect(claudeRuntimeRequest('s',{action:'reload-skills'})).rejects.toThrow('permission_pending');
 expect(rpc).toHaveBeenCalledWith('s','claude-runtime-control',{action:'reload-skills'});
});
it('does not accept an operation ack as a runtime status',()=>{
 expect(isRuntimeStatus({operationId:'op'})).toBe(false);
 expect(isRuntimeStatus(null)).toBe(false);
});

it('distinguishes SDK refusal and partial rewind from completed transport',()=>{
 expect(runtimeOutcome({id:'1',action:'background-tasks',status:'completed',result:{backgrounded:false}}).key).toBe('nothingBackgrounded');
 expect(runtimeOutcome({id:'2',action:'rewind-apply',status:'completed',result:{canRewind:false,error:'missing backup'}})).toEqual({key:'rewindUnavailable',detail:'missing backup'});
 expect(runtimeOutcome({id:'3',action:'rewind-apply',status:'completed',result:{canRewind:true,skippedLinks:2}})).toEqual({key:'rewindPartial',skipped:2});
 expect(runtimeOutcome({id:'4',action:'rewind-apply',status:'completed',result:{canRewind:true,skippedLinks:0}}).key).toBe('done');
});
