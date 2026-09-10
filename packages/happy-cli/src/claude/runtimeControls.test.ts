import { describe,it,expect,vi } from 'vitest';
import { createRuntimeControls, isRuntimeCheckpointReplay } from './runtimeControls';
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function setup() {
 const q={canControl:vi.fn(()=>true),reloadSkills:vi.fn(async()=>({skills:[]})),reloadPlugins:vi.fn(async()=>({})),mcpServerStatus:vi.fn(async()=>[{name:'x',status:'connected',config:{env:{TOKEN:'secret'}}}]),reconnectMcpServer:vi.fn(async()=>{}),toggleMcpServer:vi.fn(async()=>{}),stopTask:vi.fn(async()=>{}),backgroundTasks:vi.fn(async()=>false),rewindFiles:vi.fn(async()=>({canRewind:true,filesChanged:['test.txt'],insertions:1,deletions:0}))};
 const thinking=vi.fn(()=>false),controls=createRuntimeControls(thinking);controls.setQuery(q as any);
 return {q,controls,thinking};
}
describe('Claude runtime controls',()=>{
 it('does not dispatch with no query, during callbacks, or concurrently',async()=>{
  const {q,controls}=setup();q.canControl.mockReturnValue(false);
  expect(controls.request({action:'reload-skills'})).toHaveProperty('error');expect(q.reloadSkills).not.toHaveBeenCalled();
  q.canControl.mockReturnValue(true);let resolve!:()=>void;q.reloadSkills.mockImplementation(()=>new Promise<any>(r=>{resolve=()=>r({skills:[]});}));
  const first=controls.request({action:'reload-skills'});await flush();
  expect(controls.request({action:'reload-skills'})).toHaveProperty('error');resolve();await flush();
  expect(controls.request({action:'operation',operationId:first.operationId})).toMatchObject({status:'completed'});
  controls.setQuery(null);expect(controls.request({action:'reload-skills'})).toHaveProperty('error');
 });
 it('rechecks callback state before dispatch and removes credentials from MCP status',async()=>{
  const {q,controls}=setup();const blocked=controls.request({action:'reload-skills'});q.canControl.mockReturnValue(false);await flush();
  expect(q.reloadSkills).not.toHaveBeenCalled();expect(controls.request({action:'operation',operationId:blocked.operationId})).toMatchObject({status:'failed'});
  q.canControl.mockReturnValue(true);const op=controls.request({action:'mcp-status'});await flush();
  expect(JSON.stringify(controls.request({action:'operation',operationId:op.operationId}))).not.toContain('secret');
 });
 it('uses real task IDs and treats backgroundTasks as an action',async()=>{
  const {q,controls}=setup();expect(controls.request({action:'stop-task',taskId:'unknown'})).toHaveProperty('error');
  controls.observe({type:'system',subtype:'task_started',task_id:'t1',tool_use_id:'u1',description:'Child'} as any);
  controls.request({action:'stop-task',taskId:'t1'});await flush();expect(q.stopTask).toHaveBeenCalledWith('t1');
  const op=controls.request({action:'background-tasks',toolUseId:'u1'});await flush();
  expect(controls.request({action:'operation',operationId:op.operationId})).toMatchObject({result:{backgrounded:false}});
 });
 it('requires preview confirmation, rejects changed manifests and new-query tokens',async()=>{
  const {q,controls}=setup();controls.observe({type:'user',isReplay:true,uuid:'checkpoint',message:{content:'Do work'}} as any);
  expect(controls.request({action:'rewind-apply',confirmationToken:'fake'})).toHaveProperty('error');
  const preview=controls.request({action:'rewind-preview',userMessageId:'checkpoint'});await flush();
  const result=controls.request({action:'operation',operationId:preview.operationId}).result as any;
  expect(result.confirmationToken).toBeTruthy();q.rewindFiles.mockResolvedValue({canRewind:true,filesChanged:['different.txt'],insertions:1,deletions:0});
  const apply=controls.request({action:'rewind-apply',confirmationToken:result.confirmationToken});await flush();
  expect(controls.request({action:'operation',operationId:apply.operationId})).toMatchObject({status:'failed'});
  expect(q.rewindFiles.mock.calls.every((call:any)=>call[1].dryRun===true)).toBe(true);
  controls.setQuery(q as any);expect(controls.request({action:'rewind-apply',confirmationToken:result.confirmationToken})).toHaveProperty('error');
 });
 it('applies a matching preview once, only while idle',async()=>{
  const {q,controls,thinking}=setup();controls.observe({type:'user',isReplay:true,uuid:'checkpoint',message:{content:[{type:'text',text:'Work'}]}} as any);
  thinking.mockReturnValue(true);expect(controls.request({action:'rewind-preview',userMessageId:'checkpoint'})).toHaveProperty('error');thinking.mockReturnValue(false);
  const preview=controls.request({action:'rewind-preview',userMessageId:'checkpoint'});await flush();const token=(controls.request({action:'operation',operationId:preview.operationId}).result as any).confirmationToken;
  controls.request({action:'rewind-apply',confirmationToken:token});await flush();expect(q.rewindFiles).toHaveBeenLastCalledWith('checkpoint',{dryRun:false});
  expect(controls.request({action:'rewind-apply',confirmationToken:token})).toHaveProperty('error');
 });
});

it('suppresses only SDK replay prompts, preserving tool results and child messages',()=>{
 const message={type:'user',isReplay:true,uuid:'u',message:{content:'hello'}} as any;
 expect(isRuntimeCheckpointReplay(message)).toBe(true);
 expect(isRuntimeCheckpointReplay({...message,isReplay:false})).toBe(false);
 expect(isRuntimeCheckpointReplay({...message,parent_tool_use_id:'child'})).toBe(false);
 expect(isRuntimeCheckpointReplay({...message,message:{content:[{type:'tool_result'}]}})).toBe(false);
});

it('does not revive a stopped task from delayed progress',()=>{
 const {controls}=setup();
 controls.observe({type:'system',subtype:'task_notification',task_id:'t',status:'stopped'} as any);
 controls.observe({type:'system',subtype:'task_updated',task_id:'t'} as any);
 expect(controls.request({action:'status'}).tasks).toEqual([{id:'t',status:'stopped'}]);
});
it('does not issue a rewind token if activity changed during dry-run',async()=>{
 const {controls,q}=setup();controls.observe({type:'user',isReplay:true,uuid:'checkpoint',message:{content:'Work'}} as any);
 let resolve!: (result:any)=>void;q.rewindFiles.mockImplementation(()=>new Promise<any>(r=>{resolve=r;}));
 const preview=controls.request({action:'rewind-preview',userMessageId:'checkpoint'});await flush();
 controls.observe({type:'assistant',message:{content:[{type:'text',text:'changed'}]}} as any);
 resolve({canRewind:true,filesChanged:[]});await flush();
 expect(controls.request({action:'operation',operationId:preview.operationId})).toMatchObject({status:'failed'});
});

it('fences old query operations and ignores late completion without blocking the next query',async()=>{
 const {controls,q}=setup();
 const originalGeneration=controls.request({action:'status'}).queryGeneration;
 let resolve!: (result:any)=>void;q.reloadSkills.mockImplementationOnce(()=>new Promise<any>(r=>{resolve=r;}));
 const old=controls.request({action:'reload-skills'});await flush();
 controls.setQuery(null);controls.setQuery(q as any);
 expect(controls.request({action:'status'})).toMatchObject({active:true,busy:false,operations:[]});
 expect(controls.request({action:'status'}).queryGeneration).not.toBe(originalGeneration);
 expect(controls.request({action:'operation',operationId:old.operationId})).toMatchObject({status:'failed'});
 const next=controls.request({action:'reload-skills'});await flush();
 expect(controls.request({action:'operation',operationId:next.operationId})).toMatchObject({status:'completed'});
 resolve({skills:['old-query']});await flush();
 expect(controls.request({action:'operation',operationId:old.operationId})).toMatchObject({status:'failed'});
 expect(JSON.stringify(controls.request({action:'status'}))).not.toContain('old-query');
});
