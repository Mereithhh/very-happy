import {it,expect,vi} from 'vitest';
import {readChildThread} from './readChildThread';
it('only reads threads explicitly linked by this parent',async()=>{
    const readThread=vi.fn(async({threadId}:{threadId:string})=>({thread:{id:threadId,turns:threadId==='parent'?[{id:'p',items:[{id:'spawn',type:'collabAgentToolCall',receiverThreadIds:['child']}]}]:[{id:'c',items:[{id:'cmd',type:'commandExecution',command:'sleep 2',status:'inProgress'}]}]}}));
    const client={threadId:'parent',readThread};
    await expect(readChildThread(client,'other')).rejects.toThrow('not a child');
    expect(readThread).toHaveBeenCalledTimes(1);
    const result=await readChildThread(client,'child');
    expect(result.envelopes.some(e=>e.ev.t==='tool-call-start')).toBe(true);
    expect(result.envelopes.some(e=>e.ev.t==='tool-call-end')).toBe(false);
});

it('accepts the native subAgentActivity linkage returned by current app-server', async () => {
    const readThread = vi.fn(async ({threadId}: {threadId:string}) => ({thread: {
        id: threadId,
        turns: [{id:'turn',items:threadId === 'parent'
            ? [{id:'activity',type:'subAgentActivity',kind:'started',agentThreadId:'child'}]
            : [{id:'answer',type:'agentMessage',text:'CHILD_OK'}]}],
    }}));
    const result = await readChildThread({threadId:'parent',readThread}, 'child');
    expect(result.envelopes.some(e => e.ev.t === 'text' && e.ev.text === 'CHILD_OK')).toBe(true);
});
