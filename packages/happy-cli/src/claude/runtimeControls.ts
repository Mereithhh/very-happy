import { randomUUID, randomInt } from 'node:crypto';
import type { Query, SDKMessage, RewindFilesResult, McpServerStatus } from '@anthropic-ai/claude-agent-sdk';

export type RuntimeQuery = Pick<Query, 'reloadSkills' | 'reloadPlugins' | 'mcpServerStatus' | 'reconnectMcpServer' | 'toggleMcpServer' | 'stopTask' | 'backgroundTasks' | 'rewindFiles'> & { canControl: () => boolean };
type Operation = { id:string; queryGeneration:number; action:string; status:'running'|'completed'|'failed'; result?:unknown; error?:string };
const text = (value:unknown) => typeof value==='string' && value.length>0 && value.length<=1024 && !value.includes('\0') ? value : null;
const publicMcpStatus = (servers:McpServerStatus[]) => servers.map(({name,status,serverInfo,scope,tools})=>({name,status,serverInfo,scope,tools:tools?.map(({name})=>({name}))}));
const fingerprint = (result:RewindFilesResult) => JSON.stringify([result.canRewind,[...(result.filesChanged??[])].sort(),result.insertions,result.deletions]);

export function isRuntimeCheckpointReplay(message:SDKMessage):boolean {
    const m=message as any;
    return m.type==='user' && m.isReplay===true && !m.parent_tool_use_id
        && !(Array.isArray(m.message?.content) && m.message.content.some((block:any)=>block.type==='tool_result'));
}

/** Session-local control state. RPCs return immediately; SDK control requests never nest inside callbacks. */
export function createRuntimeControls(isThinking:()=>boolean) {
    // A fresh wrapper must not reuse generation 1 from its predecessor.
    let query:RuntimeQuery|null=null, generation=randomInt(0, 2 ** 40), activityRevision=0;
    const operations=new Map<string,Operation>();
    const confirmations=new Map<string,{generation:number;revision:number;userMessageId:string;fingerprint:string;expires:number}>();
    const tasks=new Map<string,Record<string,unknown>>();
    const checkpoints=new Map<string,{id:string;title:string}>();
    let pending=false;
    const setQuery=(next:RuntimeQuery|null)=>{
        for(const operation of operations.values()) if(operation.status==='running') {
            operation.status='failed';operation.error='Claude query ended before this operation completed';
        }
        query=next;generation++;pending=false;confirmations.clear();tasks.clear();checkpoints.clear();
    };
    function observe(message:SDKMessage) {
        const m=message as any;
        if(m.type==='user'||m.type==='assistant') {activityRevision++;confirmations.clear();}
        const content=typeof m.message?.content==='string' ? m.message.content : Array.isArray(m.message?.content) ? m.message.content.filter((block:any)=>block.type==='text').map((block:any)=>block.text).join(' ') : '';
        if(isRuntimeCheckpointReplay(message) && text(m.uuid) && content) {
            checkpoints.set(m.uuid,{id:m.uuid,title:content.slice(0,120)});
            if(checkpoints.size>100) checkpoints.delete(checkpoints.keys().next().value!);
        }
        if(m.type==='system' && text(m.task_id) && ['task_started','task_updated','task_progress','task_notification'].includes(m.subtype)) {
            const previous=tasks.get(m.task_id);
            if(m.subtype!=='task_notification' && ['completed','failed','stopped','cancelled'].includes(String(previous?.status))) return;
            tasks.set(m.task_id,{...previous,id:m.task_id,
                ...(text(m.tool_use_id)?{toolUseId:m.tool_use_id}:{}),
                ...(text(m.description)?{description:m.description}:{}),
                ...(text(m.task_type)?{type:m.task_type}:{}),
                status:m.subtype==='task_notification' ? m.status??'completed' : 'running'});
            if(tasks.size>100) tasks.delete(tasks.keys().next().value!);
        }
    }
    function request(input:unknown):Record<string,unknown> {
        const r=(input && typeof input==='object' ? input : {}) as Record<string,unknown>;
        if(r.action==='status') return {queryGeneration:generation,active:!!query,isRunning:isThinking(),canRewind:!!query&&!isThinking()&&!pending&&query.canControl(),busy:pending || !!query&&!query.canControl(),tasks:[...tasks.values()],checkpoints:[...checkpoints.values()],operations:[...operations.values()].filter(op=>op.queryGeneration===generation)};
        if(r.action==='operation') {const op=operations.get(String(r.operationId));return op ? {...op} : {error:'Operation not found'};}
        const q=query;
        if(!q) return {error:'No active Claude SDK query'};
        if(pending || !q.canControl()) return {error:'Claude is waiting for an interaction or another control operation; retry after it finishes'};
        const action=String(r.action), server=text(r.serverName), task=text(r.taskId), target=text(r.userMessageId);
        const runGeneration=generation, runRevision=activityRevision;
        let execute:()=>Promise<unknown>;
        switch(action) {
            case 'reload-skills': execute=()=>q.reloadSkills();break;
            case 'reload-plugins': execute=async()=>{const result=await q.reloadPlugins();return {...result,mcpServers:publicMcpStatus(result.mcpServers??[])};};break;
            case 'mcp-status': execute=async()=> publicMcpStatus(await q.mcpServerStatus());break;
            case 'mcp-reconnect': if(!server)return {error:'Invalid server name'};execute=()=>q.reconnectMcpServer(server);break;
            case 'mcp-toggle': if(!server || typeof r.enabled!=='boolean')return {error:'Invalid server or enabled flag'};execute=()=>q.toggleMcpServer(server,r.enabled as boolean);break;
            case 'stop-task': if(!task || !tasks.has(task))return {error:'Unknown task in this query'};execute=()=>q.stopTask(task);break;
            case 'background-tasks': if(r.toolUseId!==undefined&&!text(r.toolUseId))return {error:'Invalid tool use ID'};execute=async()=>({backgrounded:await q.backgroundTasks(r.toolUseId as string|undefined)});break;
            case 'rewind-preview':
                if(isThinking() || !target || !checkpoints.has(target))return {error:'Rewind requires an idle query and a known user checkpoint'};
                execute=async()=>{const result=await q.rewindFiles(target,{dryRun:true});if(!result.canRewind)return result;
                    if(query!==q || generation!==runGeneration || activityRevision!==runRevision || isThinking() || !q.canControl())throw Error('Query changed; preview again');
                    const token=randomUUID();confirmations.set(token,{generation,revision:activityRevision,userMessageId:target,fingerprint:fingerprint(result),expires:Date.now()+300000});
                    return {...result,confirmationToken:token};};break;
            case 'rewind-apply': {
                const confirmation=confirmations.get(String(r.confirmationToken));
                if(isThinking() || !confirmation || confirmation.generation!==generation || confirmation.expires<Date.now())return {error:'Preview expired or query is running; preview again'};
                confirmations.delete(String(r.confirmationToken));
                execute=async()=>{const fresh=await q.rewindFiles(confirmation.userMessageId,{dryRun:true});
                    if(query!==q || generation!==runGeneration || activityRevision!==confirmation.revision || isThinking() || !q.canControl() || fingerprint(fresh)!==confirmation.fingerprint)throw Error('Files or query changed; preview again');
                    return q.rewindFiles(confirmation.userMessageId,{dryRun:false});};break;
            }
            default:return {error:'Unknown Claude control action'};
        }
        pending=true;
        const op:Operation={id:randomUUID(),queryGeneration:runGeneration,action,status:'running'};operations.set(op.id,op);
        if(operations.size>50)for(const [id,old] of operations){if(old.status!=='running'){operations.delete(id);break;}}
        void Promise.resolve().then(()=>{if(query!==q || generation!==runGeneration || !q.canControl())throw Error('Claude query changed or is waiting for an interaction');return execute();}).then(result=>{if(generation!==runGeneration || op.status!=='running')return;op.status='completed';op.result=result??null;},error=>{if(generation!==runGeneration || op.status!=='running')return;op.status='failed';op.error=error instanceof Error?error.message:'Claude control failed';}).finally(()=>{if(generation===runGeneration)pending=false;});
        return {operationId:op.id};
    }
    return {setQuery,observe,request};
}
