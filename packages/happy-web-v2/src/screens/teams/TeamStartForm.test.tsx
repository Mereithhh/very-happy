// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { it, expect, vi } from 'vitest';
const mocks=vi.hoisted(()=>({recent:vi.fn(),recents:[{machineId:'m',path:'~/project'}] as {machineId:string;path:string}[],projects:{status:'ready',projects:[] as any[],members:[]}}));
const machine={id:'m',active:true,activeAt:Date.now(),metadata:{host:'computer',homeDir:'/home/executor',teamLaunchVersion:1}};
vi.mock('@/sync/storage',()=>({useMachine:()=>machine,useAllSessions:()=>[],useProfile:()=>({id:'owner'}),useAllMachines:()=>[machine],useSetting:(key:string)=>key==='recentMachinePaths'?mocks.recents:key==='newSessionAgent'?'codex':[]}));
vi.mock('@/app/newChat',()=>({recordRecentMachinePath:mocks.recent}));
vi.mock('@/sync/serverConfig',()=>({getServerUrl:()=> 'http://local.invalid'}));
vi.mock('@/i18n/useTranslation',()=>({useTranslation:()=>({lang:'en',t:(key:string)=>key})}));
vi.mock('@/screens/files/FsBrowser',()=>({FsBrowser:()=>null}));
vi.mock('@/sync/teams',()=>({TeamsApiError:class extends Error {status=500;}}));
vi.mock('@/sync/projects',()=>({useProjects:()=>mocks.projects}));
import {TeamStartForm} from './TeamStartForm';
it('uses visible recent defaults, resolves the execution home, and preserves the request across an uncertain failure',async()=>{
 Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});localStorage.clear();
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host);const started=vi.fn();const start=vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({id:'team'});
 try{
 await act(async()=>root.render(<MemoryRouter><TeamStartForm onStart={start} onStarted={started}/></MemoryRouter>));
 // UI-P0-01: folded only because computer AND folder are both known; a plain disclosure button, not a controlled <details>.
 expect(host.querySelector('details')).toBeNull();expect(host.querySelector('.team-start-toggle')?.getAttribute('aria-expanded')).toBe('false');expect(host.textContent).toContain('~/project');
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
 await act(async()=>{(host.querySelector('.team-start-toggle') as HTMLButtonElement).click();});
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

it('UI-P0-01: with no known folder the configuration is open and the disabled button says what is missing', async () => {
 Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});localStorage.clear();mocks.recents=[];
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
 try{
 await act(async()=>root.render(<MemoryRouter><TeamStartForm onStart={vi.fn()} onStarted={vi.fn()}/></MemoryRouter>));
 expect(host.querySelector('.team-start-toggle')?.getAttribute('aria-expanded')).toBe('true');
 expect((host.querySelector('.team-start-send') as HTMLButtonElement).disabled).toBe(true);
 expect(host.querySelector('#team-start-blocker')?.textContent).toBe('Describe the goal first');
 const input=host.querySelector('textarea')!;
 await act(async()=>{Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(input,'Ship it');input.dispatchEvent(new Event('input',{bubbles:true}));});
 expect(host.querySelector('#team-start-blocker')?.textContent).toBe('Choose a working folder first');
 expect(host.querySelector('.team-start-send')?.getAttribute('aria-describedby')).toBe('team-start-blocker');
 // Toggling stays stable (no native toggle event fighting React state).
 const toggle=host.querySelector('.team-start-toggle') as HTMLButtonElement;
 await act(async()=>{toggle.click();});expect(toggle.getAttribute('aria-expanded')).toBe('false');
 await act(async()=>{toggle.click();});expect(toggle.getAttribute('aria-expanded')).toBe('true');
 }finally{await act(async()=>root.unmount());host.remove();localStorage.clear();mocks.recents=[{machineId:'m',path:'~/project'}];}
});

it('B-726: a new team defaults to「新建同名项目」and sends project.create; a project page preselects its project', async () => {
 Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});localStorage.clear();
 mocks.projects={status:'ready',projects:[{id:'p1',name:'very-happy',archivedAt:null,teamIds:[],folders:[]}],members:[]};
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host);const start=vi.fn().mockResolvedValue({id:'team'});
 const submit=async(goal:string)=>{const input=host.querySelector('textarea')!;
  await act(async()=>{Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(input,goal);input.dispatchEvent(new Event('input',{bubbles:true}));});
  await act(async()=>{host.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));});};
 try{
 await act(async()=>root.render(<MemoryRouter><TeamStartForm chooseProject onStart={start} onStarted={vi.fn()}/></MemoryRouter>));
 expect(host.querySelector('#team-start-project')?.tagName).toBe('BUTTON');
 expect(host.querySelector('#team-start-project')?.textContent).toContain('New project');
 await submit('Fix login');
 expect(start.mock.calls[0][4]).toEqual({create:true});
 await act(async()=>root.render(<MemoryRouter><TeamStartForm key="p" intentScope="p" chooseProject initialProjectId="p1" onStart={start} onStarted={vi.fn()}/></MemoryRouter>));
 expect(host.querySelector('#team-start-project')?.textContent).toContain('very-happy');
 await submit('Fix logout');
 expect(start.mock.calls[1][4]).toEqual({projectId:'p1'});
 // Without the picker (starting an existing team) nothing is sent — the old request shape.
 await act(async()=>root.render(<MemoryRouter><TeamStartForm key="x" intentScope="x" onStart={start} onStarted={vi.fn()}/></MemoryRouter>));
 await submit('Start');
 expect(start.mock.calls[2][4]).toBeUndefined();
 }finally{await act(async()=>root.unmount());host.remove();localStorage.clear();mocks.projects={status:'ready',projects:[],members:[]};}
});
