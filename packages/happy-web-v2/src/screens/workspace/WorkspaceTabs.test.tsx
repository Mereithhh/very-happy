// @vitest-environment happy-dom
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
vi.mock('@/i18n/useTranslation',()=>({useTranslation:()=>({lang:'en'})}));
vi.mock('@/ui',()=>({ActionContextMenu:({children}:{children:ReactNode})=>children}));
import { WorkspaceTabs } from './WorkspaceTabs';
it('renders only a close action and keeps keyboard reorder available without action menus',async()=>{
 Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});
 const scroll=HTMLElement.prototype.scrollIntoView; HTMLElement.prototype.scrollIntoView=vi.fn();
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
 const move=vi.fn(),close=vi.fn();
 try {
  await act(async()=>root.render(<WorkspaceTabs tabs={[{id:'a',title:'First'},{id:'b',title:'Second'}]} active="b" onSelect={vi.fn()} onClose={close} onMove={move}/>));
  for(const tab of host.querySelectorAll('.workspace-tab')) {
   const actions=tab.querySelectorAll('button:not([role=tab])');expect(actions).toHaveLength(1);expect(actions[0].className).toBe('workspace-tab-close');
  }
  const tab=host.querySelector('[data-tab-id="b"]')!;
  await act(async()=>tab.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',altKey:true,shiftKey:true,bubbles:true})));
  expect(move).toHaveBeenCalledWith('b','a');
  await act(async()=>host.querySelector<HTMLButtonElement>('.workspace-tab-close')!.click());
  expect(close).toHaveBeenCalledWith('a');
 } finally {await act(async()=>root.unmount());host.remove();HTMLElement.prototype.scrollIntoView=scroll;}
});

it('reveals the active tab within its strip without scrolling containing pages', async () => {
 Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
 const rect=vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockImplementation(function(this:HTMLElement){
  const left=this.classList.contains('workspace-tabstrip')?0:240;
  const width=this.classList.contains('workspace-tabstrip')?200:80;
  return {x:left,y:900,left,right:left+width,top:900,bottom:940,width,height:40,toJSON:()=>({})};
 });
 const previous=HTMLElement.prototype.scrollIntoView;
 const ancestorScroll=vi.fn(()=>{host.scrollTop=900;});HTMLElement.prototype.scrollIntoView=ancestorScroll;
 try {
  await act(async()=>root.render(<WorkspaceTabs tabs={[{id:'a',title:'First'},{id:'b',title:'Second'}]} active="b" onSelect={vi.fn()} onClose={vi.fn()} onMove={vi.fn()}/>));
  expect(host.querySelector('.workspace-tabstrip')?.scrollLeft).toBe(120);
  expect(host.scrollTop).toBe(0);
  expect(ancestorScroll).not.toHaveBeenCalled();
 } finally {await act(async()=>root.unmount());host.remove();rect.mockRestore();HTMLElement.prototype.scrollIntoView=previous;}
});
