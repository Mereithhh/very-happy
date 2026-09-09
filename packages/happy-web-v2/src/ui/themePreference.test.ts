import { afterEach, expect, it, vi } from 'vitest';
import { runInNewContext } from 'node:vm';
import { renderStartupSplash } from '../../build/startupSplash';
import { readThemePreference } from './themePreference';
afterEach(()=>vi.unstubAllGlobals());
it.each(['dark','light','system','bad',null])('pre-paint and React share stored preference %s',value=>{
 const localStorage={getItem:()=>value}; vi.stubGlobal('localStorage',localStorage);
 let attribute:string|null=null;
 const document={documentElement:{setAttribute:(_key:string,v:string)=>{attribute=v;},removeAttribute:()=>{attribute=null;}}};
 const html=renderStartupSplash('<!-- vh-startup-style -->');
 const script=html.match(/<script>([\s\S]*?)<\/script>/)![1];
 runInNewContext(script,{localStorage,document});
 const preference=readThemePreference();
 expect(attribute).toBe(preference==='system'?null:preference);
});
it('blocked local storage falls back to system without breaking startup',()=>{
 vi.stubGlobal('localStorage',{getItem:()=>{throw new Error('blocked');}});
 expect(readThemePreference()).toBe('system');
});
