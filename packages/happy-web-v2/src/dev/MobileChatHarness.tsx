import { RelayBadge } from '@/components/RelayBadge';
import { CommandView } from '@/screens/session/CommandView';
import { Markdown } from '@/screens/session/Markdown';
import { MessageView } from '@/screens/session/MessageView';
/** DEV-only visual harness for the real structured-chat tool presentation. */
import { useEffect, useState } from 'react';
import type { ToolCallMessage } from '@/sync/typesMessage';
import type { NormalizedMessage } from '@/sync/typesRaw';
import type { Session } from '@/sync/storageTypes';
import { storage } from '@/sync/storage';
import { useLiveStreamStore } from '@/sync/liveStreamStore';
import { ChatHeader } from '@/screens/session/ChatHeader';
import { ChatList } from '@/screens/session/ChatList';
import { TurnActivityView } from '@/screens/session/TurnActivityView';
import { ToolGroupView } from '@/screens/session/ToolGroupView';
import { AgentInput } from '@/screens/session/AgentInput';
import { useToast } from '@/ui/Toast';
import '@/screens/session/session.css';

function message(id: string, name: string, state: ToolCallMessage['tool']['state'], input: Record<string, unknown>): ToolCallMessage {
  return {
    kind: 'tool-call',
    id,
    localId: null,
    createdAt: Date.now(),
    seq: Number(id.replace(/\D/g, '')) || 1,
    tool: {
      name,
      state,
      input,
      result: state === 'running' ? undefined : { stdout: 'completed output\nsecond line' },
      createdAt: Date.now(),
      startedAt: Date.now(),
      completedAt: state === 'running' ? null : Date.now(),
      description: null,
    },
    children: [],
  };
}

export function MobileChatHarness() {
  const toast = useToast();
  const [theme, setTheme] = useState('light');
  const showProgress = (status?: 'requesting' | 'compacting') => {
    useLiveStreamStore.getState().ingest('mobile-chat-live', { t: 'progress', inputTokens: 1200, outputTokens: 864, cacheTokens: 72000, thinkingTokens: 2400, status });
  };
  useEffect(() => {
    const previous = document.documentElement.dataset.theme;
    document.documentElement.dataset.theme = theme;
    return () => {
      if (previous) document.documentElement.dataset.theme = previous;
      else delete document.documentElement.dataset.theme;
    };
  }, [theme]);
  useEffect(() => {
    const now = Date.now();
    showProgress();
    storage.getState().applySessions([{
      id: 'mobile-chat-permission',
      seq: 1,
      createdAt: now,
      updatedAt: now,
      active: true,
      activeAt: now,
      metadata: {
        machineId: 'dev-machine',
        path: '/repo',
        host: 'mac-office',
        flavor: 'claude',
        claudeSessionId: '11111111-1111-4111-8111-111111111111',
        capabilities: ['claude-steer-v1', 'claude-live-permission-v1'],
      },
      metadataVersion: 1,
      agentState: {
        controlledByUser: false,
        requests: { permission: { tool: 'Bash', createdAt: now } },
      },
      agentStateVersion: 1,
      thinking: true,
      thinkingAt: now,
      thinkingStartedAt: now - 14000,
      presence: 'online',
    } as unknown as Session]);
    const liveSession = storage.getState().sessions['mobile-chat-permission'];
    storage.getState().applySessions([{ ...liveSession, id: 'mobile-chat-live', agentState: { controlledByUser: false, requests: {} } }]);
    storage.getState().applySessions([{ ...liveSession, id: 'mobile-chat-edit', thinking: false, thinkingStartedAt: null, agentState: { controlledByUser: false, requests: {} } }]);
    storage.getState().applyMessages('mobile-chat-live', [{ role:'agent', content:[{type:'text',text:'真实 ChatList 流式布局示例',uuid:'live-seed',parentUUID:null}], id:'live-seed',localId:null,createdAt:now,isSidechain:false } satisfies NormalizedMessage]);
    storage.getState().applyMessagesLoaded('mobile-chat-live');
    useLiveStreamStore.getState().ingest('mobile-chat-live',{t:'block-start',mid:'visual-stream',idx:0,kind:'text'});

    storage.getState().applyMessages('mobile-chat-permission', [{
      role: 'agent',
      content: [{ type: 'text', text: 'Working fixture', uuid: 'dev-usage', parentUUID: null }],
      id: 'dev-usage',
      localId: null,
      createdAt: now,
      isSidechain: false,
      model: 'claude-sonnet-4-6',
      usage: { input_tokens: 72_000, output_tokens: 800 },
    } satisfies NormalizedMessage]);
  }, []);
  const completed = [message('1', 'Read', 'completed', { file_path: '/repo/src/App.tsx' })];
  const running = [message('2', 'Bash', 'running', { command: 'pnpm test' })];
  const run = [
    message('3', 'Read', 'completed', { file_path: '/repo/src/a.ts' }),
    message('4', 'Read', 'completed', { file_path: '/repo/src/b.ts' }),
    message('5', 'Edit', 'completed', { file_path: '/repo/src/a.ts' }),
    message('6', 'Bash', 'completed', { command: 'pnpm test' }),
    message('7', 'WebSearch', 'completed', { query: 'React mobile rendering' }),
  ];
  return (
    <main style={{ minHeight: '100dvh', background: 'var(--bg-0)', color: 'var(--text)', padding: 16 }}>
      <div style={{ width: '100%', maxWidth: 820, margin: '0 auto', display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 20 }}>
        <button onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}>Theme: {theme}</button>
        <section data-testid="reading-polish" style={{ display: 'grid', gap: 24 }}>
          <div style={{ display: 'flex', gap: 8 }}><RelayBadge status={{ transport: 'regional', state: 'connected', region: 'US West', relayId: 'example-us-west', rttMs: 128 }} /><RelayBadge status={{ transport: 'legacy', state: 'fallback' }} /></div>
          <div className="msg-agent-text"><Markdown text={'这次更新让对话更容易阅读，也让工具执行过程更清楚。\n\n## 清楚的信息层级\n\n段落之间留出呼吸空间，`pnpm test` 保留代码的辨识度。\n\n- 统一正文与列表的阅读节奏。\n- 保留长命令和复杂内容的完整性。\n  - 嵌套列表有自己的间距。\n\n### 下一步\n\n检查两种主题以及手机上的输入体验。'} /></div>
          <CommandView command={'NODE_ENV=test pnpm test --filter "chat" && echo "完成"'} stdout={'Tests  48 passed\nDuration  1.2s'} />
        </section>
        <section data-testid="message-actions" style={{ display: 'grid', gap: 16 }}>
          <MessageView sessionId="mobile-chat-edit" showMeta={false} message={{ kind: 'user-text', id: 'edit-point', localId: null, createdAt: Date.now(), seq: 1, claudeUuid: '22222222-2222-4222-8222-222222222222', text: '请检查 @example 的实现，然后解释这一处为什么要这样写。' }} />
          <MessageView sessionId="mobile-chat-permission" showMeta={false} message={{ kind: 'agent-text', id: 'answer', localId: null, createdAt: Date.now(), seq: 2, text: '可以先检查数据流，再验证结果。\n\n这里的 `@example` 应保留原样。' }} />
        </section>
        <h1 style={{ margin: 0, fontSize: 16 }}>Structured chat · mobile QA</h1>
        <button type="button" onClick={() => toast.show('Copied to clipboard', 'success', { sticky: true })}>Show copy toast</button>
        <section data-testid="live-status" style={{ border: '1px solid var(--line)' }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', padding: 8 }}>
            <button onClick={() => showProgress()}>Output usage</button>
            <button onClick={() => showProgress('requesting')}>Requesting</button>
            <button onClick={() => showProgress('compacting')}>Compacting</button>
            <button onClick={() => useLiveStreamStore.getState().clear('mobile-chat-live')}>No usage</button>
          </div>
          <button onClick={() => {
            useLiveStreamStore.getState().ingest('mobile-chat-live',{t:'block-start',mid:'visual-stream',idx:0,kind:'text'});
            useLiveStreamStore.getState().ingest('mobile-chat-live',{t:'block-delta',mid:'visual-stream',idx:0,text:('持续输出，检查自动跟随与正文末尾状态。\n\n').repeat(12)});
          }}>Grow transcript</button>
          <ChatHeader sessionId="mobile-chat-live" onToggleFiles={() => toast.show('Files action · fixture', 'success')}/><div style={{height:320,display:'flex',flexDirection:'column'}}><ChatList sessionId="mobile-chat-live"/></div>
          <output data-testid="live-status-result" style={{ display: 'block', padding: 8, fontSize: 12 }}>
            inline live status · real ChatList
          </output>
        </section>
        <section data-testid="completed-tool"><ToolGroupView tools={completed} /></section>
        <section data-testid="running-tool"><ToolGroupView tools={running} /></section>
        <section data-testid="command-run"><TurnActivityView sessionId="mobile-chat-live" live messages={[
            ...Array.from({ length: 10 }, (_, i) => message('command-' + i, ['Bash', 'CodexBash', 'execute'][i % 3], 'completed', i % 3 === 2 ? { piTool: 'bash', command: 'git status --short' } : { command: i % 3 === 1 ? ['git', 'status', '--short'] : 'git status --short' })),
            message('command-live', 'Bash', 'running', { command: 'pnpm test' }),
          ]} /></section>
        <section data-testid="tool-run"><ToolGroupView tools={run} /></section>
        <section
          data-testid="mobile-composer-shell"
          style={{ height: 560, minHeight: 0, overflow: 'hidden' }}
        >
          <div className="sd">
            <div className="sd-main">
              <div className="sd-body">
                <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 12 }}>
                  {Array.from({ length: 24 }, (_, index) => (
                    <p key={index} style={{ margin: '0 0 12px' }}>
                      Transcript line {index + 1} · mobile composer boundary fixture
                    </p>
                  ))}
                </div>
              </div>
              <div className="sd-foot">
                <AgentInput sessionId="mobile-chat-permission" />
              </div>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
