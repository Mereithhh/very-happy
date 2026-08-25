/** DEV-only visual harness for the real structured-chat tool presentation. */
import { useEffect, useState } from 'react';
import type { ToolCallMessage } from '@/sync/typesMessage';
import type { Session } from '@/sync/storageTypes';
import { storage } from '@/sync/storage';
import { SessionLiveStatusBar } from '@/screens/session/SessionLiveStatusBar';
import { ToolGroupView } from '@/screens/session/ToolGroupView';

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
  const [statusActivated, setStatusActivated] = useState(0);
  useEffect(() => {
    const now = Date.now();
    storage.getState().applySessions([{
      id: 'mobile-chat-permission',
      seq: 1,
      createdAt: now,
      updatedAt: now,
      active: true,
      activeAt: now,
      metadata: { machineId: 'dev-machine', path: '/repo' },
      metadataVersion: 1,
      agentState: { requests: { permission: { tool: 'Bash', createdAt: now } } },
      agentStateVersion: 1,
      thinking: false,
      thinkingAt: 0,
      presence: 'online',
    } as unknown as Session]);
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
      <div style={{ width: '100%', maxWidth: 820, margin: '0 auto', display: 'grid', gap: 20 }}>
        <h1 style={{ margin: 0, fontSize: 16 }}>Structured chat · mobile QA</h1>
        <section data-testid="live-status" style={{ border: '1px solid var(--line)' }}>
          <SessionLiveStatusBar
            sessionId="mobile-chat-permission"
            onActivate={() => setStatusActivated((count) => count + 1)}
          />
          <output data-testid="live-status-result" style={{ display: 'block', padding: 8, fontSize: 12 }}>
            jump requests: {statusActivated}
          </output>
        </section>
        <section data-testid="completed-tool"><ToolGroupView tools={completed} /></section>
        <section data-testid="running-tool"><ToolGroupView tools={running} /></section>
        <section data-testid="tool-run"><ToolGroupView tools={run} /></section>
      </div>
    </main>
  );
}
