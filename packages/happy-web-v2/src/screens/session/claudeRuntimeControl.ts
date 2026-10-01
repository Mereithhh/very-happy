import { apiSocket } from '@/sync/apiSocket';

export type RuntimeTask = {id:string;toolUseId?:string;description?:string;type?:string;status:string};
export type RuntimeOperation = {id:string;action:string;status:string;result?:unknown;error?:string};
export type RuntimeStatus = {
    queryGeneration:number; active:boolean; busy:boolean; isRunning:boolean; canRewind:boolean;
    tasks:RuntimeTask[]; checkpoints:{id:string;title:string}[]; operations:RuntimeOperation[];
};
export async function claudeRuntimeRequest(sessionId:string, request:Record<string,unknown>, opts?:{timeoutMs?:number}): Promise<any> {
    const response=opts
        ? await apiSocket.sessionRPC<any,Record<string,unknown>>(sessionId,'claude-runtime-control',request,opts)
        : await apiSocket.sessionRPC<any,Record<string,unknown>>(sessionId,'claude-runtime-control',request);
    if(!response || typeof response!=='object') throw Error('Invalid runtime response');
    if(response.error) throw Error(String(response.error));
    return response;
}
export function isRuntimeStatus(value:unknown): value is RuntimeStatus {
    const data=value as RuntimeStatus | undefined;
    return !!data && typeof data.queryGeneration==='number' && typeof data.active==='boolean' && typeof data.busy==='boolean' && typeof data.isRunning==='boolean' && typeof data.canRewind==='boolean' && Array.isArray(data.tasks)
        && Array.isArray(data.checkpoints) && Array.isArray(data.operations);
}

/** Promise completion is transport state; rewind/background results can still decline the operation. */
export function runtimeOutcome(operation:RuntimeOperation): {key:'done'|'nothingBackgrounded'|'rewindUnavailable'|'rewindPartial';detail?:string;skipped?:number} {
    const result=operation.result && typeof operation.result==='object' ? operation.result as Record<string,unknown> : {};
    if(operation.action==='background-tasks' && result.backgrounded===false) return {key:'nothingBackgrounded'};
    if(operation.action==='rewind-apply') {
        if(result.canRewind!==true || result.error) return {key:'rewindUnavailable',detail:typeof result.error==='string'?result.error:undefined};
        if(typeof result.skippedLinks==='number' && result.skippedLinks>0) return {key:'rewindPartial',skipped:result.skippedLinks};
    }
    return {key:'done'};
}

/**
 * B-527: stop one background task and wait for the runner's verdict. The RPC
 * only returns an operation id; the stop itself runs afterwards and may fail.
 * Short timeouts: this is a button press, not a long job — an unreachable
 * runner must say so in seconds, not after the 5-minute session-RPC default.
 */
export async function stopBackgroundTask(sessionId:string, taskId:string, opts:{timeoutMs?:number;pollMs?:number;sleep?:(ms:number)=>Promise<void>}={}): Promise<void> {
    const timeoutMs=opts.timeoutMs ?? 15_000, pollMs=opts.pollMs ?? 700;
    const sleep=opts.sleep ?? ((ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms)));
    const deadline=Date.now()+timeoutMs;
    const started=await claudeRuntimeRequest(sessionId,{action:'stop-task',taskId},{timeoutMs});
    if(typeof started.operationId!=='string') throw Error('Missing operation id');
    while(Date.now()<deadline) {
        await sleep(pollMs);
        const op=await claudeRuntimeRequest(sessionId,{action:'operation',operationId:started.operationId},{timeoutMs:Math.max(1000,deadline-Date.now())}).catch((e:unknown)=>{
            if(e instanceof Error && /Operation not found/.test(e.message)) return {status:'running'};
            throw e;
        });
        if(op.status==='completed') return;
        if(op.status==='failed') throw Error(typeof op.error==='string' ? op.error : 'Stop failed');
    }
    throw Error('Timed out waiting for the session to stop the task');
}
