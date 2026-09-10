// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mock=vi.hoisted(()=>({machines:[] as any[],rpc:vi.fn(),ack:vi.fn(),navigate:vi.fn()}));
vi.mock('@/sync/storage',()=>({useAllMachines:()=>mock.machines,useLocalSettingMutable:()=>[{},mock.ack]}));
vi.mock('@/sync/apiSocket',()=>({apiSocket:{machineRPC:mock.rpc}}));
vi.mock('react-router-dom',()=>({useNavigate:()=>mock.navigate}));
vi.mock('@/i18n/useTranslation',()=>({useTranslation:()=>({t:(key:string)=>key})}));
import { CliUpdateBanner } from './CliUpdateBanner';
let host:HTMLDivElement,root:Root;
const render=()=>act(()=>root.render(<CliUpdateBanner/>));
const button=(key:string)=>[...host.querySelectorAll('button')].find(b=>b.textContent===`cliUpdate.${key}`)!;
beforeEach(()=>{
 (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true; vi.clearAllMocks();
 mock.machines=[{id:'target',active:true,metadata:{host:'office'},daemonState:{cliUpdate:{currentVersion:'0.2.132',recommendedVersion:'0.2.133',checkedAt:Date.now(),manualUpdateSupported:true,autoUpdateVersion:null,autoUpdate:{state:'unapproved'}}}}];
 host=document.createElement('div');document.body.append(host);root=createRoot(host);
});
afterEach(()=>{act(()=>root.unmount());host.remove();});
it('guards rapid clicks, renders pending then accepted without claiming installation',async()=>{
 let resolve!:(value:unknown)=>void;mock.rpc.mockImplementation(()=>new Promise(r=>{resolve=r;}));render();
 act(()=>{const b=button('updateNow');b.click();b.click();});
 expect(mock.rpc).toHaveBeenCalledExactlyOnceWith('target','cli-update-request',{version:'0.2.133'});
 expect(button('requesting').disabled).toBe(true);
 await act(async()=>resolve({accepted:true}));expect(button('requested').disabled).toBe(true);
 expect(host.textContent).toContain('cliUpdate.requestAccepted');expect(host.textContent).not.toContain('installed');
});
it('keeps a failed RPC retryable and does not hide the notice',async()=>{
 mock.rpc.mockResolvedValue({error:'update_policy_changed_or_unavailable'});render();await act(async()=>button('updateNow').click());
 expect(host.querySelector('[role=alert]')?.textContent).toBe('cliUpdate.requestFailed');expect(button('updateNow').disabled).toBe(false);expect(mock.ack).not.toHaveBeenCalled();
});
it('provides a pinned command on old CLI without issuing an unsupported RPC',async()=>{
 delete mock.machines[0].daemonState.cliUpdate.manualUpdateSupported;render();await act(async()=>button('manualUpdate').click());
 expect(mock.rpc).not.toHaveBeenCalled();expect(host.querySelector('code')?.textContent).toBe('npm install -g --allow-scripts=very-happy-cli,node-pty very-happy-cli@0.2.133 && very-happy daemon start');
 expect(button('copyCommand')).toBeDefined();
});
it('does not move an accepted action to a different machine',async()=>{
 let resolve!:(value:unknown)=>void;mock.rpc.mockImplementation(()=>new Promise(r=>{resolve=r;}));render();act(()=>button('updateNow').click());
 mock.machines=[{...mock.machines[0],id:'other'}];render();await act(async()=>resolve({accepted:true}));
 expect(button('updateNow').disabled).toBe(false);expect(host.textContent).not.toContain('cliUpdate.requestAccepted');
});
it('switches to reported progress after a manual request and hides duplicate action',()=>{
 mock.machines[0].daemonState.cliUpdate.autoUpdate={state:'waiting_idle',version:'0.2.133',source:'manual'};render();
 expect(host.textContent).toContain('cliUpdate.automaticTitle');expect(button('updateNow')).toBeUndefined();
});

it('allows an explicit retry when acknowledged progress never arrives',async()=>{
 vi.useFakeTimers();try {
  mock.rpc.mockResolvedValue({accepted:true});render();await act(async()=>button('updateNow').click());
  expect(button('requested').disabled).toBe(true);
  await act(async()=>vi.advanceTimersByTimeAsync(30_000));expect(button('updateNow').disabled).toBe(false);
  expect(mock.rpc).toHaveBeenCalledTimes(1);
 } finally {vi.useRealTimers();}
});
