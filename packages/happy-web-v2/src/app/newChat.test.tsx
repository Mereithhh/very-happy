// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ spawn: vi.fn(), alert: vi.fn(), configure: vi.fn(), navigate: vi.fn(), mode: vi.fn(), decision: {kind:'spawn',machineId:'m',directory:'/repo'} }));
vi.mock('@/sync/storage', () => ({ storage: {getState: () => ({machines:{},settings:{},localSettings:{},updateSessionPermissionMode:mocks.mode})} }));
vi.mock('@/sync/sync', () => ({sync:{applySettings:vi.fn()}}));
vi.mock('@/sync/ops', () => ({machineSpawnNewSession:mocks.spawn}));
vi.mock('@/sync/agentDefaults', () => ({normalizeAgentKey:()=> 'claude',resolveNewSessionPermissionMode:()=> 'default'}));
vi.mock('@/utils/quickChat', () => ({decideQuickChat:()=>mocks.decision,pushRecentMachinePath:()=>[]}));
vi.mock('@/modal', () => ({Modal:{alert:mocks.alert}}));
vi.mock('@/text', () => ({t:(key:string)=>key}));
import {createChatOrConfigure,useNewChatPending} from './newChat';
function Feedback(){return <button disabled={useNewChatPending()}>{useNewChatPending() ? 'Creating' : 'New chat'}</button>;}
it('publishes pending feedback across entries, rejects duplicate creation and recovers after failure', async () => {
 Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
 let reject!: (error:Error)=>void;
 mocks.spawn.mockImplementationOnce(()=>new Promise((_,r)=>{reject=r;}));
 try {
  await act(async()=>root.render(<><Feedback/><Feedback/></>));
  let pending!:Promise<void>;
  await act(async()=>{pending=createChatOrConfigure(mocks.navigate,mocks.configure);});
  expect([...host.querySelectorAll('button')].every(button=>button.disabled && button.textContent==='Creating')).toBe(true);
  await createChatOrConfigure(mocks.navigate,mocks.configure);expect(mocks.spawn).toHaveBeenCalledTimes(1);
  await act(async()=>{reject(new Error('offline'));await pending;});
  expect([...host.querySelectorAll('button')].every(button=>!button.disabled)).toBe(true);
  expect(mocks.alert).toHaveBeenCalled();expect(mocks.navigate).not.toHaveBeenCalled();
  mocks.spawn.mockResolvedValueOnce({type:'success',sessionId:'created'});
  await act(async()=>{await createChatOrConfigure(mocks.navigate,mocks.configure);});
  expect(mocks.navigate).toHaveBeenCalledWith('/session/created');
  expect(host.querySelector('button')?.disabled).toBe(false);
 } finally {await act(async()=>root.unmount());host.remove();}
});
