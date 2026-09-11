import { useEffect, useRef, useState } from 'react';
import { ChatHeader } from '@/screens/session/ChatHeader';
import { AgentInput } from '@/screens/session/AgentInput';
import { ModelEffortMenu } from '@/screens/session/ModelEffortMenu';
import { EffortSlider } from '@/components/EffortSlider';
import { storage } from '@/sync/storage';
import type { Session } from '@/sync/storageTypes';
import { apiSocket } from '@/sync/apiSocket';
import { sync } from '@/sync/sync';
import '@/screens/session/session.css';

const id = 'composer-feedback-example';
const machineId = 'composer-feedback-machine';
const levels = [{key:'low',name:'low'},{key:'medium',name:'medium'},{key:'high',name:'high'},{key:'max',name:'max'}];

/** Real UI components with local, manually completed delivery; never contacts an agent. */
export function ComposerFeedbackHarness() {
    const [ready, setReady] = useState(false);
    const [effort, setEffort] = useState('max');
    const [calls, setCalls] = useState(0);
    const [working, setWorking] = useState(false);
    const pending = useRef<{resolve: () => void; reject: () => void} | null>(null);
    useEffect(() => {
        const now = Date.now();
        storage.getState().applySessions([{
            id, seq:1, createdAt:now, updatedAt:now, active:true, activeAt:now,
            metadata:{machineId,path:'/workspace/example',host:'dev-sg',flavor:'claude',summary:{text:'检查配置并汇总结果 · 本地示例',updatedAt:now},capabilities:['claude-steer-v1']},
            metadataVersion:1, agentState:{controlledByUser:false,requests:{}},agentStateVersion:1,
            thinking:false,thinkingAt:now,thinkingStartedAt:null,presence:'online',
        } as unknown as Session]);
        const originalSend = sync.sendMessage;
        const originalStatus = apiSocket.getMachineRelayStatus;
        apiSocket.getMachineRelayStatus = target => target === machineId ? {transport:'regional',state:'connected',region:'Singapore',relayId:'example-sg',rttMs:38} : originalStatus.call(apiSocket,target);
        sync.sendMessage = async (sessionId, ...args) => {
            if (sessionId !== id) return originalSend.call(sync, sessionId, ...args);
            setCalls(count => count + 1);
            await new Promise<void>((resolve,reject) => { pending.current = {resolve,reject:() => reject(new Error('Local example failure'))}; });
            pending.current = null;
            return `example-${Date.now()}`;
        };
        setReady(true);
        return () => { pending.current?.resolve(); sync.sendMessage = originalSend; apiSocket.getMachineRelayStatus = originalStatus; };
    }, []);
    const toggleWorking = () => {
        const next = !working;
        const session = storage.getState().sessions[id];
        storage.getState().applySessions([{...session,thinking:next,thinkingAt:Date.now(),thinkingStartedAt:next ? Date.now() : null}]);
        setWorking(next);
    };
    return <main style={{minHeight:'100dvh',background:'var(--bg-0)',color:'var(--text)'}}>
        {ready && <ChatHeader sessionId={id} onToggleFiles={() => {}} onToggleBtw={() => {}}/>}
        <div style={{maxWidth:760,margin:'0 auto',padding:16,display:'grid',gap:24}}>
            <p>本地示例 · 发送、中继与思考档；不会发送给真实 Agent。</p>
            <div style={{display:'flex',gap:12,flexWrap:'wrap'}}>
                <button onClick={() => pending.current?.resolve()}>完成模拟发送</button>
                <button onClick={() => pending.current?.reject()}>模拟发送失败</button>
                <button onClick={toggleWorking}>Working: {String(working)}</button>
                <output data-testid="delivery-count">提交次数：{calls}</output>
            </div>
            {ready && <AgentInput sessionId={id}/>}
            <section data-testid="effort-example" style={{display:'grid',gap:20}}>
                <EffortSlider label="思考强度" options={levels} value={effort} onChange={setEffort}/>
                <div><ModelEffortMenu label="模型示例" options={[{key:'example-model',name:'Claude'}]} value="example-model" onChange={() => {}} effort={{label:'思考强度',options:levels,value:effort,onChange:setEffort}}/></div>
            </section>
        </div>
    </main>;
}
