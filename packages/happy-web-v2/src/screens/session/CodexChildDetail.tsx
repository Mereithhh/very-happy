import { useEffect, useState } from 'react';
import type { Message, ToolCallMessage } from '@/sync/typesMessage';
import { apiSocket } from '@/sync/apiSocket';
import { normalizeRawMessage } from '@/sync/typesRaw';
import { createReducer, reducer } from '@/sync/reducer/reducer';
import { ActivityMessages } from './ActivityMessages';
import { Markdown } from './Markdown';
import { useTranslation } from '@/i18n/useTranslation';
import { AgentGlyph } from './AgentChip';
import { shortThreadId } from './agentIdentity';

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
    // B-614: same anatomy as SubagentDetail — facts, briefing, then one
    // segmented thread switcher (Codex glyph + short id; full id on hover).
    return <div className="sa">
        {typeof input?.model==='string'&&<div className="sa-head"><span className="sa-facts"><span className="sa-model">{t('session.chat.subagentRequestedModel')}: {input.model}</span></span></div>}
        {typeof input?.prompt==='string'&&<div className="sa-brief"><Markdown text={input.prompt}/></div>}
        {ids.length>0&&<div className="sa-threads vh-segmented" role="group" aria-label={t('session.chat.subagentLog')}>{ids.map(id=><button key={id} type="button" className="sa-thread" aria-pressed={id===selected} title={id} onClick={()=>setSelected(id)}><AgentGlyph kind="codex" size={13}/><span className="vh-segmented-label">{shortThreadId(id)}</span></button>)}</div>}
        {error&&<div role="status" className="tg-error">{error}</div>}
        {loading&&selected&&<div role="status" className="sa-empty">{t('session.chat.loadingMessages')}</div>}
        <div className="sa-log"><ActivityMessages messages={messages} sessionId={sessionId} subagentNavigation="inline"/></div>
    </div>;
}
