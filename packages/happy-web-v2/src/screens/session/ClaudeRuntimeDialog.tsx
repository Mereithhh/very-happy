import { useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { Button, Spinner } from '@/ui';
import { useTranslation } from '@/i18n/useTranslation';
import { claudeRuntimeRequest, isRuntimeStatus, runtimeOutcome, type RuntimeStatus } from './claudeRuntimeControl';
import './sessionOptionsDialog.css';
import './claudeRuntimeDialog.css';

type McpServer = {name:string;status:string;serverInfo?:{name?:string;version?:string};tools?:{name:string}[]};
type RewindPreview = {canRewind:boolean;confirmationToken?:string;filesChanged?:string[];insertions?:number;deletions?:number;error?:string};

export function ClaudeRuntimeDialog({sessionId,open,onOpenChange}:{sessionId:string;open:boolean;onOpenChange:(open:boolean)=>void}) {
    const {t}=useTranslation();
    const [status,setStatus]=useState<RuntimeStatus|null>(null);
    const [error,setError]=useState('');
    const [pollError,setPollError]=useState('');
    const titleRef=useRef<HTMLHeadingElement>(null);
    const completedId=useRef('');
    const requestEpoch=useRef(0);
    const queryGeneration=useRef<number|null>(null);
    const [submitting,setSubmitting]=useState(false);
    const [lastId,setLastId]=useState('');
    const [checkpoint,setCheckpoint]=useState('');
    const [servers,setServers]=useState<McpServer[]|null>(null);
    const [preview,setPreview]=useState<RewindPreview|null>(null);
    const [refresh,setRefresh]=useState(0);
    useEffect(()=>{
        requestEpoch.current++;queryGeneration.current=null;completedId.current='';setSubmitting(false);setStatus(null);setError('');setPollError('');setLastId('');setCheckpoint('');setServers(null);setPreview(null);
        return ()=>{requestEpoch.current++;};
    },[sessionId,open]);
    useEffect(()=>{
        if(!open) return;
        let canceled=false, pending=false;
        async function read() {
            if(pending || document.hidden) return;
            pending=true;
            try {
                const value=await claudeRuntimeRequest(sessionId,{action:'status'});
                if(!isRuntimeStatus(value)) throw Error('Invalid runtime status');
                if(!canceled) {
                    if(queryGeneration.current!==null && queryGeneration.current!==value.queryGeneration) {
                        requestEpoch.current++;completedId.current='';setSubmitting(false);setLastId('');setCheckpoint('');setServers(null);setPreview(null);setError('');
                    }
                    queryGeneration.current=value.queryGeneration;setStatus(value);setPollError('');
                }
            } catch(e) {if(!canceled)setPollError(e instanceof Error?e.message:String(e));}
            finally {pending=false;}
        }
        void read();
        const timer=setInterval(()=>void read(),1500);
        return ()=>{canceled=true;clearInterval(timer);};
    },[sessionId,open,refresh]);
    const operation=status?.operations.find(op=>op.id===lastId);
    useEffect(()=>{
        if(operation?.status!=='completed' || completedId.current===operation.id) return;
        completedId.current=operation.id;
        if(operation.action==='mcp-status' && Array.isArray(operation.result)) setServers(operation.result as McpServer[]);
        if(operation.action==='rewind-preview' && operation.result && typeof operation.result==='object') setPreview(operation.result as RewindPreview);
        if(operation.action==='rewind-apply') setPreview(null);
        if(operation.action==='mcp-toggle' || operation.action==='mcp-reconnect') void action('mcp-status');
    },[operation]);
    const pendingOperation=!!(lastId && !operation) || (status?.operations.some(op=>op.status==='running') ?? false);
    const disabled=submitting || pendingOperation || !status?.active || status.busy;
    async function action(action:string,params:Record<string,unknown>={}) {
        if(disabled) return;
        const epoch=requestEpoch.current;
        setSubmitting(true);setError('');setPreview(null);
        try {
            const response=await claudeRuntimeRequest(sessionId,{action,...params});
            if(epoch!==requestEpoch.current) return;
            if(typeof response.operationId!=='string') throw Error('Missing operation id');
            setLastId(response.operationId);setRefresh(value=>value+1);
        } catch(e) {if(epoch===requestEpoch.current)setError(e instanceof Error?e.message:String(e));}
        finally {if(epoch===requestEpoch.current)setSubmitting(false);}
    }
    const outcome=operation?.status==='completed' ? runtimeOutcome(operation) : null;
    const taskStatus=(value:string)=>t(`runtimeControls.task.${['running','completed','failed','stopped'].includes(value)?value:'unknown'}` as 'runtimeControls.task.running');
    return <Dialog.Root open={open} onOpenChange={onOpenChange}>
        <Dialog.Portal><Dialog.Overlay className="so-overlay"/><Dialog.Content className="so-dialog runtime-controls" onOpenAutoFocus={event=>{event.preventDefault();titleRef.current?.focus();}}>
            <div className="so-head"><div><Dialog.Title ref={titleRef} tabIndex={-1} className="so-title">{t('runtimeControls.title')}</Dialog.Title>
                <Dialog.Description className="so-description">{t('runtimeControls.description')}</Dialog.Description></div>
                <Dialog.Close asChild><button className="so-close" aria-label={t('common.close')}><X size={18}/></button></Dialog.Close>
            </div>
            <div className="runtime-body">
            {!status && !error && !pollError && <Spinner/>}
            {(error || pollError) && <p role="alert" className="runtime-error">{error || pollError}</p>}
            {status && <>
                {!status.active && <p role="status">{t('runtimeControls.inactive')}</p>}
                {status.busy && <p role="status">{t('runtimeControls.busy')}</p>}
                <div role="status" className="runtime-progress">{submitting || pendingOperation ? <><Spinner size={14}/>{t('runtimeControls.working')}</> : operation?.status==='failed' ? operation.error : operation?.status==='completed' ? <span>{outcome?.detail || t(`runtimeControls.${outcome?.key ?? 'done'}`)}{outcome?.skipped ? ` (${outcome.skipped})` : ''}</span> : null}</div>
                <section><h3>{t('runtimeControls.tasks')}</h3>
                    <Button disabled={disabled || !status.isRunning} onClick={()=>void action('background-tasks')}>{t('runtimeControls.background')}</Button>
                    {status.tasks.length===0 && <p className="so-description">{t('runtimeControls.noTasks')}</p>}
                    {status.tasks.map(task=><div className="runtime-row" key={task.id}><div><span>{task.description || task.id}</span><small>{taskStatus(task.status)}</small></div>
                        {task.status==='running' && <Button disabled={disabled} onClick={()=>void action('stop-task',{taskId:task.id})}>{t('runtimeControls.stop')}</Button>}</div>)}
                </section>
                <section><h3>{t('runtimeControls.extensions')}</h3><div className="runtime-actions">
                    <Button disabled={disabled} onClick={()=>void action('reload-skills')}>{t('runtimeControls.reloadSkills')}</Button>
                    <Button disabled={disabled} onClick={()=>void action('reload-plugins')}>{t('runtimeControls.reloadPlugins')}</Button>
                </div></section>
                <section><h3>MCP</h3><Button disabled={disabled} onClick={()=>void action('mcp-status')}>{t('runtimeControls.refreshMcp')}</Button>
                    {servers?.length===0 && <p className="so-description">{t('runtimeControls.noMcp')}</p>}
                    {servers?.map(server=><div className="runtime-row" key={server.name}><div><span>{server.name}</span><small>{server.status}</small></div><div className="runtime-actions">
                        <Button disabled={disabled} onClick={()=>void action('mcp-reconnect',{serverName:server.name})}>{t('runtimeControls.reconnect')}</Button>
                        <Button disabled={disabled} onClick={()=>void action('mcp-toggle',{serverName:server.name,enabled:server.status==='disabled'})}>{t(server.status==='disabled'?'runtimeControls.enable':'runtimeControls.disable')}</Button>
                    </div></div>)}
                </section>
                <section><h3>{t('runtimeControls.rewind')}</h3><p className="so-description">{t('runtimeControls.rewindHelp')}</p>
                    <label className="runtime-checkpoint"><span>{t('runtimeControls.checkpoint')}</span><select value={checkpoint} disabled={disabled || !status.canRewind} onChange={e=>{setCheckpoint(e.target.value);setPreview(null);setLastId('');}}>
                        <option value="">{t('runtimeControls.chooseCheckpoint')}</option>{status.checkpoints.map(point=><option key={point.id} value={point.id}>{point.title}</option>)}
                    </select></label>
                    <Button disabled={disabled || !status.canRewind || !checkpoint} onClick={()=>void action('rewind-preview',{userMessageId:checkpoint})}>{t('runtimeControls.preview')}</Button>
                    {preview && <div className="runtime-preview"><p>{preview.error || t(preview.canRewind?'runtimeControls.rewindReady':'runtimeControls.rewindUnavailable')}</p>
                        <ul>{preview.filesChanged?.map(path=><li key={path}>{path}</li>)}</ul>
                        {preview.canRewind && preview.confirmationToken && <Button disabled={disabled || !status.canRewind} onClick={()=>void action('rewind-apply',{confirmationToken:preview.confirmationToken})}>{t('runtimeControls.confirmRewind')}</Button>}
                    </div>}
                </section>
            </>}
            </div>
        </Dialog.Content></Dialog.Portal>
    </Dialog.Root>;
}
