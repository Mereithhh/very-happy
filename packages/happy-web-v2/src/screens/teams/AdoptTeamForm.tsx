import { useEffect, useId, useRef, useState } from 'react';
import { z } from 'zod';
import { useSession, useProfile } from '@/sync/storage';
import { apiSocket } from '@/sync/apiSocket';
import { getServerUrl } from '@/sync/serverConfig';
import { useTranslation } from '@/i18n/useTranslation';
import { useTeamNavigation, refreshTeamNavigation } from '@/screens/sessions/useTeamNavigation';
import { SelectMenu } from '@/ui/SelectMenu';
import { pendingIntentKey, readPendingIntent, retainPendingIntent, clearPendingIntent } from './pendingIntent';
// B-730: `transfer` = the owner confirmed moving a session that already belongs to another team.
const intentSchema = z.object({ requestId: z.string().min(1), name: z.string().min(1), teamId: z.string().min(1).optional(), transfer: z.literal(true).optional() });
type Intent = z.infer<typeof intentSchema>;
type Connected = {status:'connected';teamId:string;botId:string;instructions:string};
type Refused = {error:string;safeToChange?:true;code?:string;teamId?:string;teamName?:string};
export function AdoptTeamForm(props: {sessionId:string;onDone:()=>void}) {
  const profile=useProfile();
  return <AdoptTeamFormContent key={`${getServerUrl()}:${profile.id}:${props.sessionId}`} {...props} />;
}
function AdoptTeamFormContent({sessionId,onDone}: {sessionId:string;onDone:()=>void}) {
  const {lang} = useTranslation(); const zh=lang.startsWith('zh'); const fieldId=useId();
  const session=useSession(sessionId); const teams=useTeamNavigation(); const profile=useProfile();
  const key=profile.id ? pendingIntentKey(getServerUrl(),profile.id,`adopt:${sessionId}`) : '';
  const [teamId,setTeamId]=useState(''); const [busy,setBusy]=useState(false); const [error,setError]=useState('');
  const [intent,setIntent]=useState<Intent|null>(null); const [restored,setRestored]=useState(false);
  const [conflict,setConflict]=useState<{teamName:string;teamId?:string}|null>(null);
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
        const result=await apiSocket.sessionRPC<Connected|{status:'pending'}|Refused,Intent>(sessionId,'teams-adopt',input);
        if(!result || typeof result!=='object')throw Error('invalid_response');
        if('error' in result){
          if(result.safeToChange===true){safeToChange=true;clearPendingIntent(key,input.requestId);if(stillHere())setIntent(null);}
          // B-730: nothing was created or joined; ask the owner before moving the session out of its team.
          if(result.code==='session_in_other_team'&&safeToChange&&!input.transfer){if(stillHere())setConflict({teamName:result.teamName||result.teamId||'',...(result.teamId?{teamId:result.teamId}:{})});return;}
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
  async function start(transfer?:true) {
    try {
      const input=retainPendingIntent(key,{requestId:crypto.randomUUID(),name:(session?.metadata?.summary?.text||session?.metadata?.path?.split('/').pop()||'Team').slice(0,128),...(teamId?{teamId}:{}),...(transfer?{transfer}:{})},value=>intentSchema.parse(value));
      setConflict(null);setIntent(input);await resume(input);
    }catch{setError(zh?'无法保存连接请求，未发起连接。请检查浏览器存储。':'Cannot save the connection request. Nothing was sent; check browser storage.');}
  }
  return <form className="team-start-form" onSubmit={async event=>{
    event.preventDefault(); if(!eligible || busy || !key || !restored || conflict)return;
    await start();
  }}>
    <p>{zh?'保留当前对话，让它担任负责人。系统会连接团队并发送协作指引。':'Keep this conversation and make it the team lead. We connect the team and send the collaboration instructions.'}</p>
    <div className="teams-field"><span id={`${fieldId}-team`}>{zh?'团队':'Team'}</span><SelectMenu variant="soft" size="md" label={zh?'团队':'Team'} labelledBy={`${fieldId}-team`} value={teamId} disabled={busy||!!intent||!restored} onChange={setTeamId} options={[{value:'',label:zh?'创建新团队':'Create a new team'},...teams.filter(t=>t.machineId===session?.metadata?.machineId).map(t=>({value:t.id,label:t.name}))]} /></div>
    {intent&&<p role="status">{zh?'已有连接请求，继续处理原请求；离开页面后也可以回来重试。':'A saved connection request is being resumed. You can leave and return to retry it.'}</p>}
    {!eligible&&<p role="status">{zh?'此会话尚不支持直接组队，请使用新版 CLI 新建会话。':'This conversation cannot connect a team directly. Start a new session with the updated CLI.'}</p>}
    {error&&<p role="alert">{error}</p>}
    {conflict&&<div className="team-adopt-conflict" role="alertdialog" aria-labelledby={`${fieldId}-conflict`}>
      <p id={`${fieldId}-conflict`}>{zh?`这个对话已经是团队「${conflict.teamName}」的成员或负责人。一般应在原团队里继续派活；确认转移后，它会离开「${conflict.teamName}」（在那里标记为已转移），改为带领新团队。`:`This conversation already leads or works in team "${conflict.teamName}". Usually it should keep delegating there. If you transfer it, it leaves "${conflict.teamName}" (marked as transferred there) and leads the new team.`}</p>
      <div className="team-adopt-conflict-actions">
        <button type="button" onClick={()=>setConflict(null)}>{zh?'取消':'Cancel'}</button>
        <button type="button" className="teams-primary" disabled={busy} onClick={()=>void start(true)}>{zh?'确认转移':'Transfer'}</button>
      </div>
    </div>}
    <button className="teams-primary" disabled={!eligible||busy||!restored||!!conflict}>{busy?(zh?'正在连接…':'Connecting…'):intent?(zh?'继续连接':'Continue connecting'):(zh?'用这个对话带队':'Lead with this conversation')}</button>
  </form>;
}
