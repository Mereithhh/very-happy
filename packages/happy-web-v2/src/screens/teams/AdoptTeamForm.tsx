import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { useSession, useProfile } from '@/sync/storage';
import { apiSocket } from '@/sync/apiSocket';
import { getServerUrl } from '@/sync/serverConfig';
import { useTranslation } from '@/i18n/useTranslation';
import { useTeamNavigation, refreshTeamNavigation } from '@/screens/sessions/useTeamNavigation';
import { pendingIntentKey, readPendingIntent, retainPendingIntent, clearPendingIntent } from './pendingIntent';
const intentSchema = z.object({ requestId: z.string().min(1), name: z.string().min(1), teamId: z.string().min(1).optional() });
type Intent = z.infer<typeof intentSchema>;
type Connected = {status:'connected';teamId:string;botId:string;instructions:string};
export function AdoptTeamForm(props: {sessionId:string;onDone:()=>void}) {
  const profile=useProfile();
  return <AdoptTeamFormContent key={`${getServerUrl()}:${profile.id}:${props.sessionId}`} {...props} />;
}
function AdoptTeamFormContent({sessionId,onDone}: {sessionId:string;onDone:()=>void}) {
  const {lang} = useTranslation(); const zh=lang.startsWith('zh');
  const session=useSession(sessionId); const teams=useTeamNavigation(); const profile=useProfile();
  const key=profile.id ? pendingIntentKey(getServerUrl(),profile.id,`adopt:${sessionId}`) : '';
  const [teamId,setTeamId]=useState(''); const [busy,setBusy]=useState(false); const [error,setError]=useState('');
  const [intent,setIntent]=useState<Intent|null>(null); const [restored,setRestored]=useState(false);
  const mounted=useRef(true); const running=useRef(false); const currentKey=useRef(key); currentKey.current=key;
  const done=useRef(onDone);done.current=onDone;
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false}},[]);
  const eligible = !!session?.metadata?.capabilities?.includes('teams-adopt-v1') && session.archivedAt == null;
  async function resume(input:Intent) {
    if(running.current)return;
    running.current=true;setBusy(true);setError('');
    let safeToChange=false;
    const stillHere=()=>mounted.current&&currentKey.current===key;
    try {
      const deadline=Date.now()+60_000;
      while(stillHere()){
        const result=await apiSocket.sessionRPC<Connected|{status:'pending'}|{error:string;safeToChange?:true},Intent>(sessionId,'teams-adopt',input);
        if(!result || typeof result!=='object')throw Error('invalid_response');
        if('error' in result){
          if(result.safeToChange===true){safeToChange=true;clearPendingIntent(key,input.requestId);if(stillHere())setIntent(null);}
          throw Error(result.error);
        }
        if(result.status==='connected'){
          // The wrapper retains this identity forever. Keep its non-secret request
          // so another page load can recover even before membership is refreshed.
          if(stillHere()){void refreshTeamNavigation();done.current();}
          return;
        }
        if(result.status!=='pending')throw Error('invalid_response');
        if(Date.now()>deadline)throw Error('pending');
        await new Promise(resolve=>setTimeout(resolve,1000));
      }
    }catch{if(stillHere())setError(safeToChange ? (zh?'连接尚未开始，可以选择其他团队后重试。':'The connection has not started. You can choose another team and retry.') : (zh?'暂未完成。连接请求已保存，重试会继续原请求。':'Not complete yet. Your connection request is saved; retry continues it.'));}
    finally{running.current=false;if(stillHere())setBusy(false);}
  }
  useEffect(()=>{
    setRestored(false);
    if(!key)return;
    try {
      const saved=readPendingIntent(key,value=>intentSchema.parse(value));
      setIntent(saved);setTeamId(saved?.teamId??'');setRestored(true);
      if(saved&&eligible)void resume(saved);
    }catch{setError(zh?'无法恢复已保存的连接请求，未发起新请求。':'Cannot recover the saved connection request. No new request was sent.');}
  },[key,eligible]);
  return <form className="team-start-form" onSubmit={async event=>{
    event.preventDefault(); if(!eligible || busy || !key || !restored)return;
    try {
      const input=retainPendingIntent(key,{requestId:crypto.randomUUID(),name:(session?.metadata?.summary?.text||session?.metadata?.path?.split('/').pop()||'Team').slice(0,128),...(teamId?{teamId}:{})},value=>intentSchema.parse(value));
      setIntent(input);await resume(input);
    }catch{setError(zh?'无法保存连接请求，未发起连接。请检查浏览器存储。':'Cannot save the connection request. Nothing was sent; check browser storage.');}
  }}>
    <p>{zh?'保留当前对话，让它担任负责人。系统会连接团队并发送协作指引。':'Keep this conversation and make it the team lead. We connect the team and send the collaboration instructions.'}</p>
    <label>{zh?'团队':'Team'}<select value={teamId} disabled={busy||!!intent||!restored} onChange={e=>setTeamId(e.target.value)}><option value="">{zh?'创建新团队':'Create a new team'}</option>{teams.filter(t=>t.machineId===session?.metadata?.machineId).map(t=><option value={t.id} key={t.id}>{t.name}</option>)}</select></label>
    {intent&&<p role="status">{zh?'已有连接请求，继续处理原请求；离开页面后也可以回来重试。':'A saved connection request is being resumed. You can leave and return to retry it.'}</p>}
    {!eligible&&<p role="status">{zh?'此会话尚不支持直接组队，请使用新版 CLI 新建会话。':'This conversation cannot connect a team directly. Start a new session with the updated CLI.'}</p>}
    {error&&<p role="alert">{error}</p>}
    <button className="teams-primary" disabled={!eligible||busy||!restored}>{busy?(zh?'正在连接…':'Connecting…'):intent?(zh?'继续连接':'Continue connecting'):(zh?'用这个对话带队':'Lead with this conversation')}</button>
  </form>;
}
