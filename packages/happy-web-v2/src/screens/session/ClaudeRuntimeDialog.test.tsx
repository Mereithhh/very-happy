// @vitest-environment happy-dom
import {act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
const rpc=vi.hoisted(()=>vi.fn());
vi.mock('@/sync/apiSocket',()=>({apiSocket:{sessionRPC:rpc}}));
vi.mock('@/i18n/useTranslation',()=>({useTranslation:()=>({t:(key:string)=>key})}));
vi.mock('@/ui',()=>({Button:(p:any)=><button {...p}/>,Spinner:()=>null}));
vi.mock('@radix-ui/react-dialog',()=>({Root:({open,children}:any)=>open?children:null,Portal:({children}:any)=>children,Overlay:()=>null,Content:({children}:any)=><div>{children}</div>,Title:({children}:any)=><h1>{children}</h1>,Description:({children}:any)=><p>{children}</p>,Close:({children}:any)=>children}));
import {ClaudeRuntimeDialog} from './ClaudeRuntimeDialog';
let host:HTMLDivElement,root:Root;
const status=(generation=1)=>({queryGeneration:generation,active:true,busy:false,isRunning:false,canRewind:true,tasks:[],checkpoints:[],operations:[] as any[]});
async function show(sessionId:string){await act(async()=>{root.render(<ClaudeRuntimeDialog sessionId={sessionId} open onOpenChange={()=>{}}/>);});}
async function click(key:string){const btn=[...host.querySelectorAll('button')].find(b=>b.textContent===key)!;expect(btn).toBeTruthy();await act(async()=>btn.click());}
beforeEach(()=>{(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;vi.useFakeTimers();host=document.createElement('div');document.body.append(host);root=createRoot(host);rpc.mockReset();});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.useRealTimers();});
it('discards a late action failure after switching sessions',async()=>{
 let reject!:(e:Error)=>void;
 rpc.mockImplementation((_id,_method,r)=>r.action==='status'?Promise.resolve(status()):new Promise((_resolve,fail)=>{reject=fail;}));
 await show('a');await click('runtimeControls.reloadSkills');await show('b');
 await act(async()=>reject(Error('old session error')));
 expect(host.textContent).not.toContain('old session error');
 expect([...host.querySelectorAll('button')].find(b=>b.textContent==='runtimeControls.reloadSkills')!.disabled).toBe(false);
});
it('clears old MCP results when the same session changes Query generation',async()=>{
 let current=status();
 rpc.mockImplementation((_id,_method,r)=>{
  if(r.action==='status')return Promise.resolve(structuredClone(current));
  current.operations=[{id:'op',action:'mcp-status',status:'completed',result:[{name:'old-server',status:'connected'}]}];
  return Promise.resolve({operationId:'op'});
 });
 await show('a');await click('runtimeControls.refreshMcp');
 expect(host.textContent).toContain('old-server');
 current=status(2);await act(async()=>{await vi.advanceTimersByTimeAsync(1500);});
 expect(host.textContent).not.toContain('old-server');
 expect([...host.querySelectorAll('button')].find(b=>b.textContent==='runtimeControls.reloadSkills')!.disabled).toBe(false);
});
it('picks a rewind checkpoint from the searchable picker (B-714)',async()=>{
 const points=[{id:'u1',title:'first prompt'},{id:'u2',title:'second prompt '+'x'.repeat(100)}];
 rpc.mockImplementation((_id,_method,r)=>r.action==='status'?Promise.resolve({...status(),checkpoints:points}):Promise.resolve({operationId:'op'}));
 await show('a');
 expect(host.querySelector('select')).toBeNull();
 const picker=host.querySelector<HTMLButtonElement>('.runtime-checkpoint [role="combobox"]')!;
 expect(picker.textContent).toBe('runtimeControls.chooseCheckpoint');
 expect([...host.querySelectorAll('button')].find(b=>b.textContent==='runtimeControls.preview')!.disabled).toBe(true);
 await act(async()=>picker.click());
 expect(document.querySelector('[data-vh-picker-surface] input')).not.toBeNull();
 const option=[...document.querySelectorAll<HTMLElement>('[data-vh-picker-surface] [role="option"]')].find(el=>el.textContent?.startsWith('second'))!;
 expect(option.title).toBe(points[1].title);
 await act(async()=>option.click());
 expect(picker.textContent).toBe(points[1].title);
 await click('runtimeControls.preview');
 expect(rpc).toHaveBeenCalledWith('a','claude-runtime-control',{action:'rewind-preview',userMessageId:'u2'});
});
