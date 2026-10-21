// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { it, expect, vi } from 'vitest';
const mocks=vi.hoisted(()=>({recent:vi.fn()}));
const machine={id:'m',active:true,activeAt:Date.now(),metadata:{host:'computer',homeDir:'/home/executor',teamLaunchVersion:1}};
vi.mock('@/sync/storage',()=>({useMachine:()=>machine,useAllSessions:()=>[],useProfile:()=>({id:'owner'}),useAllMachines:()=>[machine],useSetting:(key:string)=>key==='recentMachinePaths'?[{machineId:'m',path:'~/project'}]:key==='newSessionAgent'?'codex':[]}));
vi.mock('@/app/newChat',()=>({recordRecentMachinePath:mocks.recent}));
vi.mock('@/sync/serverConfig',()=>({getServerUrl:()=> 'http://local.invalid'}));
vi.mock('@/i18n/useTranslation',()=>({useTranslation:()=>({lang:'en',t:(key:string)=>key})}));
vi.mock('@/screens/files/FsBrowser',()=>({FsBrowser:()=>null}));
vi.mock('@/sync/teams',()=>({TeamsApiError:class extends Error {status=500;}}));
import {TeamStartForm} from './TeamStartForm';
it('uses visible recent defaults, resolves the execution home, and preserves the request across an uncertain failure',async()=>{
 Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});localStorage.clear();
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host);const started=vi.fn();const start=vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({id:'team'});
 try{
 await act(async()=>root.render(<MemoryRouter><TeamStartForm onStart={start} onStarted={started}/></MemoryRouter>));
 expect(host.querySelector('details')?.open).toBe(false);expect(host.textContent).toContain('~/project');
 const input=host.querySelector('textarea')!;
 await act(async()=>{Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(input,'Review my project');input.dispatchEvent(new Event('input',{bubbles:true}));});
 await act(async()=>{host.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));});
 expect(start).toHaveBeenCalledTimes(1);expect(start.mock.calls[0].slice(0,3)).toEqual(['Review my project','m',{goal:'Review my project',directory:'/home/executor/project',assistant:'codex'}]);
 expect(host.textContent).toContain('Continue launch');
 await act(async()=>{host.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));});
 expect(start.mock.calls[1]).toEqual(start.mock.calls[0]);expect(started).toHaveBeenCalledWith({id:'team'});expect(mocks.recent).toHaveBeenCalledWith('m','/home/executor/project');
 }finally{await act(async()=>root.unmount());host.remove();localStorage.clear();}
});

it('B-698: harness lists only what the computer runs; the default model is a select whose choice is launched', async () => {
 Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});localStorage.clear();
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host);const start=vi.fn().mockResolvedValueOnce({id:'team'});
 try{
 await act(async()=>root.render(<MemoryRouter><TeamStartForm onStart={start} onStarted={vi.fn()}/></MemoryRouter>));
 const assistant=host.querySelector('select[name=assistant]') as HTMLSelectElement;
 // no cliAvailability.pi on this daemon → pi is not offered
 expect([...assistant.options].map(o=>o.value)).toEqual(['claude','codex']);
 const model=host.querySelector('select[name=model]') as HTMLSelectElement;
 expect(model.tagName).toBe('SELECT');
 expect(model.options[0].value).toBe('');expect(model.options[0].textContent).toBe('Follow the harness default');
 expect([...model.options].map(o=>o.value)).toContain('gpt-5.5');
 await act(async()=>{model.value='gpt-5.5';model.dispatchEvent(new Event('change',{bubbles:true}));});
 const input=host.querySelector('textarea')!;
 await act(async()=>{Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(input,'Ship it');input.dispatchEvent(new Event('input',{bubbles:true}));});
 await act(async()=>{host.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));});
 expect(start.mock.calls[0][2]).toEqual({goal:'Ship it',directory:'/home/executor/project',assistant:'codex',model:'gpt-5.5'});
 // switching the harness resets the model to "follow default"
 await act(async()=>{assistant.value='claude';assistant.dispatchEvent(new Event('change',{bubbles:true}));});
 expect((host.querySelector('select[name=model]') as HTMLSelectElement).value).toBe('');
 }finally{await act(async()=>root.unmount());host.remove();localStorage.clear();}
});
