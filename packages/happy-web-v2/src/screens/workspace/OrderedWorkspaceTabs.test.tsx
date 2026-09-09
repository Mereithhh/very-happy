// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect,it,vi } from 'vitest';
vi.mock('@/i18n/useTranslation',()=>({useTranslation:()=>({lang:'en'})}));
import { OrderedWorkspaceTabs,orderWorkspaceTabs } from './OrderedWorkspaceTabs';
it('restores known order, drops absent views and appends newly opened tabs',()=>{
 const tabs=[{id:'file:a',title:'A'},{id:'notes:b',title:'B'},{id:'extra:web',title:'Web'}];
 expect(orderWorkspaceTabs(tabs,['missing','notes:b','notes:b','file:a']).map(t=>t.id)).toEqual(['notes:b','file:a','extra:web']);
});
it('moves across owners and restores the display order without calling the wrong content owner',async()=>{
 Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});
 const previous=HTMLElement.prototype.scrollIntoView;HTMLElement.prototype.scrollIntoView=vi.fn();
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host);const move=vi.fn();
 const tabs=[{id:'file:a',title:'A',group:'files'},{id:'extra:web',title:'Web',group:'tools'}];
 const render=async(identity:string)=>act(async()=>root.render(<OrderedWorkspaceTabs identity={identity} tabs={tabs} active="extra:web" onSelect={vi.fn()} onClose={vi.fn()} onMove={move}/>));
 const ids=()=>[...host.querySelectorAll('[role=tab]')].map(e=>e.getAttribute('data-tab-id'));
 try{
  await render('order-test');await act(async()=>host.querySelector('[data-tab-id="extra:web"]')!.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',altKey:true,shiftKey:true,bubbles:true})));
  expect(ids()).toEqual(['extra:web','file:a']);expect(move).not.toHaveBeenCalled();
  await render('other');expect(ids()).toEqual(['file:a','extra:web']);
  await render('order-test');expect(ids()).toEqual(['extra:web','file:a']);
 }finally{await act(async()=>root.unmount());host.remove();HTMLElement.prototype.scrollIntoView=previous;}
});
