import { useEffect, useState } from 'react';
import type { Message, ToolCallMessage } from '@/sync/typesMessage';
import { apiSocket } from '@/sync/apiSocket';
import { normalizeRawMessage } from '@/sync/typesRaw';
import { createReducer, reducer } from '@/sync/reducer/reducer';
import { ActivityMessages } from './ActivityMessages';
import { Markdown } from './Markdown';
import { useTranslation } from '@/i18n/useTranslation';

export function CodexChildDetail({sessionId,message}:{sessionId:string;message:ToolCallMessage}) {
    const {t}=useTranslation();
    const input=message.tool.input;
    const ids: string[]=Array.isArray(input?.receiverThreadIds)?input.receiverThreadIds.filter((id:unknown)=>typeof id==='string'):[];
    const [selected,setSelected]=useState(ids[0]??'');
    const [messages,setMessages]=useState<Message[]>([]);
    const [error,setError]=useState('');
    const [loading,setLoading]=useState(true);
    useEffect(()=>{
        let canceled=false, pending=false;
        setMessages([]); setLoading(true); setError('');
        async function refresh() {
            if (!selected || pending || document.hidden) return;
            pending=true;
            try {
                const response=await apiSocket.sessionRPC<{envelopes?:unknown[];error?:string},{threadId:string}>(sessionId,'codex-child-read',{threadId:selected});
                if (response.error) throw Error(response.error);
                if (!Array.isArray(response.envelopes)) throw Error('Invalid child transcript');
                const normalized=response.envelopes.flatMap((data,index)=>{
                    const m=normalizeRawMessage(`child-${index}`,null,index,{role:'session',content:{type:'session',data}} as any);
                    return m?[{...m,seq:index}]:[];
                });
                if (!canceled) {setMessages(reducer(createReducer(),normalized).messages);setError('');}
            } catch(e) {if(!canceled)setError(e instanceof Error?e.message:String(e));}
            finally {pending=false;if(!canceled)setLoading(false);}
        }
        void refresh(); const timer=setInterval(()=>void refresh(),5000);
        return ()=>{canceled=true;clearInterval(timer);};
    },[sessionId,selected]);
    return <div className="sa">
        {typeof input?.prompt==='string'&&<Markdown text={input.prompt}/>}
        {typeof input?.model==='string'&&<span className="sa-model">{t('session.chat.subagentRequestedModel')}: {input.model}</span>}
        <div className="sa-head">{ids.map(id=><button key={id} type="button" className="sa-dock-item" aria-pressed={id===selected} onClick={()=>setSelected(id)}>{id}</button>)}</div>
        {error&&<div role="status" className="tg-error">{error}</div>}
        {loading&&selected&&<div role="status">{t('session.chat.loadingMessages')}</div>}
        <ActivityMessages messages={messages} sessionId={sessionId} subagentNavigation="inline"/>
    </div>;
}
