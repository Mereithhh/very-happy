import { expect, it } from 'vitest';
import { previewPinTarget } from './previewPinTarget';
const request={machineId:'m',sessionId:'source',path:'/dir/中文 #.xlsx',mode:'file' as const};
const machine=(id:string)=>id==='source'||id==='current'?'m':'other';
it('pins into the current matching context and URL-encodes file paths',()=>{
 const url=previewPinTarget(request,{pathname:'/session/current',search:'?panel=changes'},machine)!;
 const params=new URL(url,'https://example.test').searchParams;
 expect(url.startsWith('/session/current?')).toBe(true);expect(params.get('pinFile')).toBe(request.path);expect(params.get('panel')).toBe('browse');
});
it('preserves terminal identity and falls back only to the verified source session',()=>{
 expect(previewPinTarget(request,{pathname:'/terminal/m',search:'?tid=t'},machine)).toContain('tid=t');
 expect(previewPinTarget(request,{pathname:'/session/foreign',search:''},machine)).toContain('/session/source?');
 expect(previewPinTarget({...request,sessionId:undefined},{pathname:'/session/foreign',search:''},machine)).toBeNull();
});
