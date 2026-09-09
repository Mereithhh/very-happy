// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
vi.mock('@/i18n/useTranslation',()=>({useTranslation:()=>({t:(key:string)=>key,lang:'en'})}));
vi.mock('@/sync/storage',()=>({useLocalSettingMutable:()=>['name',vi.fn()]}));
vi.mock('@/ui',()=>({Spinner:()=>null}));
vi.mock('./FsFileViewer',()=>({FsFileViewer:({path,onClose}:{path:string;onClose:()=>void})=><button data-file={path} onClick={onClose}>Close preview</button>}));
vi.mock('@/sync/fsOps',()=>({machineFsList:vi.fn(async (_machine:string,path:string)=>({ok:true,path,entries:path.endsWith('/src')?[{name:'app.ts',type:'file',size:1}]:[{name:'src',type:'dir'}],truncated:false}))}));
import { machineFsList } from '@/sync/fsOps';
import { FsBrowser } from './FsBrowser';
it('restores directory and preview within an identity, isolates sessions and directory pickers',async()=>{
 Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
 const render=async(key:string,picker=false)=>act(async()=>root.render(<FsBrowser machineId="machine" initialPath="/repo" viewKey={key} onPickDir={picker?()=>{}:undefined}/>));
 const unmount=async()=>act(async()=>root.render(null));
 try{
  await render('one');await act(async()=>host.querySelector<HTMLButtonElement>('[aria-label="fsBrowser.showHidden"]')!.click());await act(async()=>host.querySelector<HTMLButtonElement>('[title="/repo/src"]')!.dispatchEvent(new MouseEvent('dblclick',{bubbles:true})));
  await act(async()=>host.querySelector<HTMLButtonElement>('[title="/repo/src/app.ts"]')!.click());
  expect(host.querySelector('[data-file]')?.getAttribute('data-file')).toBe('/repo/src/app.ts');
  await unmount();vi.mocked(machineFsList).mockClear();await render('one');
  expect(machineFsList).toHaveBeenCalledWith('machine','/repo/src');
  expect(host.querySelector('[data-file]')?.getAttribute('data-file')).toBe('/repo/src/app.ts');
  await render('two');expect(host.querySelector('[data-file]')).toBeNull();expect(host.querySelector('[title="/repo/src"]')).not.toBeNull();
  await render('one',true);expect(host.querySelector('[data-file]')).toBeNull();expect(host.querySelector('[title="src"]')).not.toBeNull();
  await render('one');await act(async()=>host.querySelector<HTMLButtonElement>('[data-file]')!.click());
  expect(host.querySelector('[title="/repo/src/app.ts"]')).not.toBeNull();
  expect(host.querySelector('[aria-label="fsBrowser.hideHidden"]')?.getAttribute('aria-pressed')).toBe('true');
 }finally{await act(async()=>root.unmount());host.remove();}
});


it('does not intercept Escape while its full-screen browser is hidden', async () => {
 Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
 const render=(active:boolean)=>act(async()=>root.render(<FsBrowser machineId="machine" initialPath="/repo" active={active}/>));
 try {
  await render(true);
  await act(async()=>host.querySelector<HTMLButtonElement>('[aria-label="fsBrowser.fullscreen"]')!.click());
  expect(host.querySelector('.fsb--full')).not.toBeNull();
  await render(false);
  const hiddenEscape=new KeyboardEvent('keydown',{key:'Escape',cancelable:true});
  await act(async()=>window.dispatchEvent(hiddenEscape));
  expect(hiddenEscape.defaultPrevented).toBe(false);
  expect(host.querySelector('.fsb--full')).not.toBeNull();
  await render(true);
  const visibleEscape=new KeyboardEvent('keydown',{key:'Escape',cancelable:true});
  await act(async()=>window.dispatchEvent(visibleEscape));
  expect(visibleEscape.defaultPrevented).toBe(true);
  expect(host.querySelector('.fsb--full')).toBeNull();
 } finally {await act(async()=>root.unmount());host.remove();}
});

it('expands folders in place and retains their children when a preview closes', async () => {
 Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
 try {
  await act(async()=>root.render(<FsBrowser machineId="machine" initialPath="/repo"/>));
  await act(async()=>host.querySelector<HTMLButtonElement>('[title="/repo/src"]')!.click());
  expect(host.querySelector('[title="/repo/src"]')?.getAttribute('aria-expanded')).toBe('true');
  await act(async()=>host.querySelector<HTMLButtonElement>('[title="/repo/src/app.ts"]')!.click());
  expect(host.querySelector('[data-file]')?.getAttribute('data-file')).toBe('/repo/src/app.ts');
  await act(async()=>host.querySelector<HTMLButtonElement>('[data-file]')!.click());
  expect(host.querySelector('[title="/repo/src/app.ts"]')).not.toBeNull();
  expect(host.querySelector('[title="/repo/src"]')?.getAttribute('aria-expanded')).toBe('true');
 }finally {await act(async()=>root.unmount());host.remove();}
});
