import { apiSocket } from '@/sync/apiSocket';

export type RuntimeTask = {id:string;toolUseId?:string;description?:string;type?:string;status:string};
export type RuntimeOperation = {id:string;action:string;status:string;result?:unknown;error?:string};
export type RuntimeStatus = {
    queryGeneration:number; active:boolean; busy:boolean; isRunning:boolean; canRewind:boolean;
    tasks:RuntimeTask[]; checkpoints:{id:string;title:string}[]; operations:RuntimeOperation[];
};
export async function claudeRuntimeRequest(sessionId:string, request:Record<string,unknown>): Promise<any> {
    const response=await apiSocket.sessionRPC<any,Record<string,unknown>>(sessionId,'claude-runtime-control',request);
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
