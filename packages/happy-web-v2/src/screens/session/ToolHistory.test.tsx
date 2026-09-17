// @vitest-environment happy-dom
import {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {dispatchKvChanges} from '@/sync/kvUpdates';
import {onFsPreviewOpen} from '@/sync/filePreviewOpen';
import {toolHistoryKey} from '@/sync/toolHistory';
const mocks=vi.hoisted(()=>({token:'test-account-a',decrypt:vi.fn(async(value:string)=>value),reconnect:new Set<()=>void>(),recovered:new Set<()=>void>()}));
vi.mock('@/auth/AuthContext',()=>({useAuth:()=>({credentials:{token:mocks.token,secret:'test'}})}));
vi.mock('@/sync/sync',()=>({sync:{encryption:{getSessionEncryption:()=>({decryptRaw:mocks.decrypt}),getMachineEncryption:()=>({decryptRaw:mocks.decrypt})}}}));
vi.mock('@/sync/apiSocket',()=>({getHappyClientId:()=> 'test',apiSocket:{onReconnected:(fn:()=>void)=>{mocks.reconnect.add(fn);return ()=>mocks.reconnect.delete(fn);},onRecovered:(fn:()=>void)=>{mocks.recovered.add(fn);return ()=>mocks.recovered.delete(fn);}}}));
vi.mock('@/sync/serverConfig',()=>({getServerUrl:()=> 'http://localhost'}));
vi.mock('@/i18n/useTranslation',()=>({useTranslation:()=>({lang:'en',t:(key:string)=>key})}));
vi.mock('@/ui/Toast',()=>({toast:{error:vi.fn()}}));
import {ToolHistory} from './ToolHistory';
let host:HTMLDivElement;let root:Root;let fetcher:ReturnType<typeof vi.fn>;let write:ReturnType<typeof vi.fn>;
const value=(text:string,kind='clipboard')=>Buffer.from(JSON.stringify({version:1,entries:[{id:text,kind,createdAt:1000,payload:text,enc:true}]})).toString('base64');
const response=(text:string,version=1,kind='clipboard')=>new Response(JSON.stringify({value:value(text,kind),version}));
beforeEach(()=>{
 Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});mocks.token='test-account-a';
 fetcher=vi.fn(async()=>response('previous copy'));vi.stubGlobal('fetch',fetcher);
 write=vi.fn(async()=>{});Object.defineProperty(navigator,'clipboard',{value:{writeText:write},configurable:true});
 host=document.createElement('div');document.body.append(host);root=createRoot(host);
});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals();vi.clearAllMocks();});

it('loads history on open, updates through KV, copies only on click, and refetches after reconnect',async()=>{
 const scope={machineId:'machine-a',terminalId:'terminal-a'};
 await act(async()=>root.render(<ToolHistory scope={scope} machineId="machine-a"/>));
 expect(host.textContent).toContain('previous copy');expect(write).not.toHaveBeenCalled();
 expect(String(fetcher.mock.calls[0][0])).toContain(encodeURIComponent(toolHistoryKey(scope)));
 await act(async()=>host.querySelector<HTMLButtonElement>('[aria-label="Copy again"]')!.click());
 expect(write).toHaveBeenCalledWith('previous copy');
 await act(async()=>dispatchKvChanges([{key:toolHistoryKey(scope),value:value('/repo/report.html','preview'),version:2}]));
 const opened=vi.fn();const stop=onFsPreviewOpen(opened);
 await act(async()=>host.querySelector<HTMLButtonElement>('.tool-history-open')!.click());
 expect(opened).toHaveBeenCalledWith({machineId:'machine-a',path:'/repo/report.html',sessionId:undefined,mode:'file'});stop();
 fetcher.mockResolvedValueOnce(response('after reconnect',3));
 await act(async()=>{for(const fn of mocks.reconnect)fn();});
 expect(host.textContent).toContain('after reconnect');
});

it('ignores late responses when changing terminal or account',async()=>{
 let finish!:(r:Response)=>void;fetcher.mockImplementationOnce(()=>new Promise<Response>(r=>{finish=r;}));
 await act(async()=>root.render(<ToolHistory scope={{sessionId:'old'}}/>));
 await act(async()=>root.render(<ToolHistory scope={{sessionId:'new'}}/>));
 expect(host.textContent).toContain('previous copy');
 await act(async()=>finish(response('old account data',9)));expect(host.textContent).not.toContain('old account data');
 mocks.token='test-account-b';fetcher.mockResolvedValueOnce(new Response('',{status:404}));
 await act(async()=>root.render(<ToolHistory scope={{sessionId:'new'}}/>));
 expect(host.textContent).not.toContain('previous copy');expect(host.textContent).toContain('No recorded calls yet');
});
