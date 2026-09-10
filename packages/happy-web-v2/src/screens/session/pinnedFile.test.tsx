// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, useNavigate, useLocation } from 'react-router-dom';
import { expect, it, vi } from 'vitest';
vi.mock('@/i18n/useTranslation',()=>({useTranslation:()=>({t:(key:string)=>key,lang:'en'})}));
vi.mock('@/sync/storage',()=>({useSession:(id:string)=>({metadata:{machineId:'machine',path:'/repo/'+id}})}));
vi.mock('./useFiles',()=>({useSessionFiles:()=>({projectFiles:{files:[]},gitStatusFiles:{unstagedFiles:[],stagedFiles:[]},isLoading:false,isFetching:false,refresh:vi.fn()})}));
vi.mock('@/ui',()=>({Spinner:()=>null}));
vi.mock('../files/FsBrowser',()=>({FsBrowser:()=> <div data-browser/>}));
vi.mock('./FileView',()=>({FileView:()=>null}));
vi.mock('../files/FsFileViewer',()=>({FsFileViewer:({path,onClose}:{path:string;onClose:()=>void})=><button data-viewer={path} onClick={onClose}>close file</button>}));
import { FilesPanel } from './FilesPanel';
function Fixture(){const navigate=useNavigate();const location=useLocation();return <><button onClick={()=>navigate('/session/pin-test?panel=browse&pinFile=%2Freports%2Fa.md')}>pin again</button><output>{location.search}</output><FilesPanel sessionId="pin-test" tab="browse" onClose={()=>{}}/></>;}
it('opens a pinned file as a real workspace tab, consumes the request and permits reopening after close',async()=>{
 Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
 try {
  await act(async()=>root.render(<MemoryRouter initialEntries={['/session/pin-test?panel=browse&pinFile=%2Freports%2Fa.md']}><Fixture/></MemoryRouter>));
  expect(host.querySelector('[data-viewer]')?.getAttribute('data-viewer')).toBe('/reports/a.md');
  expect(host.querySelector('output')?.textContent).not.toContain('pinFile');
  await act(async()=>host.querySelector<HTMLButtonElement>('[data-viewer]')!.click());
  expect(host.querySelector('[data-viewer]')).toBeNull();
  await act(async()=>host.querySelector<HTMLButtonElement>('button')!.click());
  expect(host.querySelector('[data-viewer]')?.getAttribute('data-viewer')).toBe('/reports/a.md');
 }finally{await act(async()=>root.unmount());host.remove();}
});
