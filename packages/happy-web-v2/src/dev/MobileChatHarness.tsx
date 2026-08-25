/** DEV-only visual harness for the real structured-chat tool presentation. */
import type { ToolCallMessage } from '@/sync/typesMessage';
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
        <section data-testid="completed-tool"><ToolGroupView tools={completed} /></section>
        <section data-testid="running-tool"><ToolGroupView tools={running} /></section>
        <section data-testid="tool-run"><ToolGroupView tools={run} /></section>
      </div>
    </main>
  );
}
