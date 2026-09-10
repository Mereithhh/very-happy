import { TurnActivityView } from '@/screens/session/TurnActivityView';
import { LiveStatusRow } from '@/screens/session/SessionLiveStatusBar';
import { LiveStreamBlocks } from '@/screens/session/LiveStreamView';
import { ActivityMessages } from '@/screens/session/ActivityMessages';
import { SessionPreviews } from '@/screens/session/SessionPreviews';
import { SubagentDock } from '@/screens/session/SubagentDock';
/** DEV-only visual harness for the sub-agent pointer row + drawer (B-317).
 *  Route is `/dev/subagent/:id` so the row sees a session id and takes the
 *  real drawer path instead of the no-session inline fallback. */
import { useEffect, useState } from 'react';
import { storage } from '@/sync/storage';
import type { Message, ToolCallMessage } from '@/sync/typesMessage';
import { ToolGroupView } from '@/screens/session/ToolGroupView';
import { SubagentPanel } from '@/screens/session/SubagentPanel';
import { onSubagentOpen } from '@/screens/session/subagentPanelState';
import '@/screens/session/session.css';
import '@/screens/session/input.css';
import '@/screens/session/chatlist.css';

const SESSION_ID = 'dev-subagent';
const NOW = Date.now();

function child(id: string, name: string, input: Record<string, unknown>, state: ToolCallMessage['tool']['state'] = 'completed'): ToolCallMessage {
    return {
        kind: 'tool-call',
        id,
        localId: null,
        createdAt: NOW,
        children: [],
        tool: { name, state, input, createdAt: NOW, startedAt: NOW, completedAt: NOW, description: null },
    };
}

function card(id: string, status: 'running' | 'completed' | 'failed' | 'stopped', extra: Record<string, unknown> = {}): ToolCallMessage {
    return {
        kind: 'tool-call',
        id,
        localId: null,
        createdAt: NOW,
        children: [{kind:'agent-text',id:`${id}-text`,localId:null,createdAt:NOW-1,text:'先核对配置，再汇总检查结果。',meta:{reportedModel:'claude-haiku-4-5-20251001'}}, ...Array.from({ length: 10 }, (_, i) =>
            child(`${id}-c${i}`, 'Bash', { command: `cd /workspace/project && git diff --stat -- src/module-${i}.ts` }))],
        subagent: { status, subagentType: 'general-purpose', updatedAt: NOW, ...extra } as ToolCallMessage['subagent'],
        tool: {
            name: 'Task',
            state: status === 'running' ? 'running' : 'completed',
            input: {
                sessionSubagent: `sub-${id}`,
                model: 'haiku',
                subagent_type: 'general-purpose',
                description: '查 API Platform TPM 配置',
                prompt: '检查项目配置，确认当前限制与配置来源。\n\n- 核对配置文件与实际生效值\n- 记录发现的问题和验证依据\n- 汇总结果，先不要修改生产配置',
            },
            createdAt: NOW,
            startedAt: NOW,
            completedAt: status === 'running' ? null : NOW + 42_000,
            description: null,
        },
    };
}

const CARDS = [
    child('preview-example','mcp__happy__open_preview',{path:'/workspace/review.md'}),
    card('task-running', 'running'),
    card('task-done', 'completed', { result: { text: '## 结论\n\nTPM 可以安全提到 200000。' }, usage: { toolUses: 10, totalTokens: 41200, durationMs: 42_000 } }),
    card('task-stopped', 'stopped'),
];

const ALIGNMENT_MESSAGES: Message[] = [
    child('align-1', 'Bash', {command:'git status --short'}),
    child('align-2', 'Bash', {command:'git diff --stat'}),
    {kind:'agent-text',id:'align-text',localId:null,createdAt:NOW,text:'先核对运行情况，再汇总检查结果。'},
    child('align-3', 'Bash', {command:'pnpm test --filter workspace'}),
    child('align-4', 'Bash', {command:'git diff -- src/workspace.ts'}),
    {kind:'agent-text',id:'align-thinking',localId:null,createdAt:NOW,isThinking:true,text:'检查本轮命令和消息的对齐情况。'},
];

export function SubagentHarness() {
    const [open, setOpen] = useState<string | null>(null);
    useEffect(() => {
        storage.setState((state) => ({
            sessions: {...state.sessions,[SESSION_ID]:{id:SESSION_ID,presence:'online',thinking:true,metadata:{machineId:'dev-machine',path:'/workspace'}} as never},
            sessionMessages: {
                ...state.sessionMessages,
                [SESSION_ID]: {
                    messages: [...CARDS].reverse(),
                    messagesMap: Object.fromEntries(CARDS.map((c) => [c.id, c])),
                    isLoaded: true,
                    hasMoreOlder: false,
                    isLoadingOlder: false,
                } as never,
            },
        }));
        return onSubagentOpen((detail) => setOpen(detail.messageId));
    }, []);
    return (
        <div className={`sd${open ? ' sd--files-open' : ''}`}>
            <div className="sd-main">
                <div className="sd-body"><div className="cl"><div className="cl-scroll"><div className="cl-inner">
                    <div style={{color:'var(--text-faint)',fontSize:'var(--fs-12)'}}>本地示例 · 主对话与子代理字体对照</div>
                    <ActivityMessages sessionId={SESSION_ID} messages={[{kind:'agent-text',id:'main-example',localId:null,createdAt:NOW,text:'先核对配置，再汇总检查结果。'}]} />
                    <div data-testid="activity-alignment" style={{display:'flex',flexDirection:'column',gap:'var(--sp-3)'}}>
                        <TurnActivityView messages={ALIGNMENT_MESSAGES} sessionId={SESSION_ID} live />
                        <LiveStreamBlocks blocks={[{key:'align-draft',kind:'thinking',text:'继续核对实时思考状态。',done:false,doneAt:null}]} />
                        <LiveStatusRow phase="requesting" label="请求中" elapsed={87} metrics={[{kind:'input',value:'1.2k'},{kind:'output',value:'864'}]} />
                    </div>
                    {CARDS.map((c) => <ToolGroupView key={c.id} tools={[c]} />)}
                </div></div></div></div>
                <div className="sd-foot"><SessionPreviews sessionId={SESSION_ID} /><SubagentDock sessionId={SESSION_ID} /><div className="ci"><div className="ci-composer"><textarea className="ci-textarea" aria-label="Message" placeholder="本地预览 · 输入内容不会发送" rows={2} /></div></div></div>
            </div>
            {open && (
                <>
                    <div className="sd-files-scrim" onClick={() => setOpen(null)} aria-hidden />
                    <aside className="sd-files">
                        <SubagentPanel sessionId={SESSION_ID} messageId={open} onClose={() => setOpen(null)} />
                    </aside>
                </>
            )}
        </div>
    );
}
