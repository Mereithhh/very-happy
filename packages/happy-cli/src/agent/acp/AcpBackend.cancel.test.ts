import {it,expect,vi} from 'vitest';
import {AcpBackend} from './AcpBackend';
it('a cancelled prompt does not announce backend death', async()=>{
 const backend = new AcpBackend({agentName:'pi',cwd:process.cwd(),command:'pi-acp'});
 const cancel=vi.fn(async()=>{});
 Object.assign(backend,{connection:{cancel},acpSessionId:'test-session'});
 const receive=vi.fn();backend.onMessage(receive);
 await backend.cancel('test-session');
 expect(cancel).toHaveBeenCalledWith({sessionId:'test-session'});
 expect(receive).toHaveBeenCalledWith({type:'status',status:'idle',detail:'Cancelled by user'});
 expect(receive.mock.calls.some(([m])=>m.status==='stopped')).toBe(false);
});
